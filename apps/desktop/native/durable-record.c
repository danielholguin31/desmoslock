#if !defined(__APPLE__)
#error "The durable record adapter requires macOS; there is no portable fallback."
#endif

#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_RECORD_BYTES 65536
#define QUARANTINE_SLOTS 16
#define LOCK_NAME "student-session.lock"
#define RECORD_NAME "student-session.record"

typedef enum { OP_OPEN, OP_LOAD, OP_REPLACE, OP_QUARANTINE, OP_CLOSE } Operation;

typedef struct {
  napi_env env;
  napi_ref owner_reference;
  napi_async_cleanup_hook_handle cleanup_hook;
  int directory_fd;
  int lock_fd;
  dev_t lock_device;
  ino_t lock_inode;
  bool busy;
  bool closed;
  bool poisoned;
  bool tearing_down;
} Store;

typedef struct {
  Store *store;
  Operation operation;
  napi_async_work work;
  napi_deferred deferred;
  char directory[PATH_MAX];
  unsigned char *bytes;
  size_t length;
  bool missing;
  bool published;
  bool poison;
  const char *code;
  const char *stage;
  int error_number;
} Work;

static Store *process_owner = NULL;
static const napi_type_tag store_tag = {0x3a6526a99b334570ULL, 0xb5f7a20109e491cdULL};

static void fail(Work *work, const char *code, const char *stage, int error_number) {
  if (work->code == NULL) {
    work->code = code;
    work->stage = stage;
    work->error_number = error_number;
  }
}

static bool close_descriptor(Work *work, int *descriptor, const char *stage) {
  if (*descriptor < 0) return true;
  int value = *descriptor;
  *descriptor = -1;
  if (close(value) == 0) return true;
  /* Never retry close: after an error the descriptor may already be reused. */
  fail(work, "STORE_IO", stage, errno);
  return false;
}

static void release_descriptors(Work *work) {
  close_descriptor(work, &work->store->directory_fd, "close-directory");
  close_descriptor(work, &work->store->lock_fd, "close-lock");
}

static bool full_sync(Work *work, int descriptor, const char *stage) {
  if (fcntl(descriptor, F_FULLFSYNC) == 0) return true;
  fail(work, "STORE_IO", stage, errno);
  return false;
}

static bool private_regular(const struct stat *status) {
  return S_ISREG(status->st_mode) && status->st_uid == geteuid() &&
         status->st_nlink == 1 && (status->st_mode & 077) == 0;
}

static bool unchanged_lock(Work *work) {
  struct stat descriptor, named;
  Store *store = work->store;
  if (fstat(store->lock_fd, &descriptor) != 0 ||
      fstatat(store->directory_fd, LOCK_NAME, &named, AT_SYMLINK_NOFOLLOW) != 0) {
    fail(work, "STORE_INVALID", "lock-identity", errno);
    work->poison = true;
    return false;
  }
  if (!private_regular(&descriptor) || !private_regular(&named) ||
      descriptor.st_dev != store->lock_device || descriptor.st_ino != store->lock_inode ||
      named.st_dev != descriptor.st_dev || named.st_ino != descriptor.st_ino) {
    fail(work, "STORE_INVALID", "lock-identity", EINVAL);
    work->poison = true;
    return false;
  }
  return true;
}

static void open_store(Work *work) {
  Store *store = work->store;
  int parent = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (parent < 0) {
    fail(work, "STORE_IO", "open-root", errno);
    return;
  }
  char *component = work->directory + 1;
  while (*component != '\0') {
    char *separator = strchr(component, '/');
    if (separator != NULL) *separator = '\0';
    bool created = false;
    int child = openat(parent, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (child < 0 && errno == ENOENT) {
      if (mkdirat(parent, component, 0700) == 0) created = true;
      else if (errno != EEXIST) {
        fail(work, "STORE_IO", "create-directory", errno);
        break;
      }
      child = openat(parent, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    }
    if (child < 0) {
      fail(work, "STORE_INVALID", "open-directory", errno);
      break;
    }
    struct stat status;
    if (fstat(child, &status) != 0 || !S_ISDIR(status.st_mode) ||
        (status.st_uid != 0 && status.st_uid != geteuid()) ||
        (separator == NULL && (status.st_uid != geteuid() || (status.st_mode & 077) != 0))) {
      fail(work, "STORE_INVALID", "directory-ownership", errno == 0 ? EINVAL : errno);
      close_descriptor(work, &child, "close-directory");
      break;
    }
    /* Also repair an owned directory chain left by interrupted initialization. */
    if ((created || status.st_uid == geteuid()) && (!full_sync(work, child, "created-directory-barrier") ||
                    !full_sync(work, parent, "directory-parent-barrier"))) {
      close_descriptor(work, &child, "close-directory");
      break;
    }
    close_descriptor(work, &parent, "close-directory");
    parent = child;
    if (work->code != NULL || separator == NULL) break;
    component = separator + 1;
  }
  if (work->code != NULL) {
    close_descriptor(work, &parent, "close-directory");
    return;
  }
  store->directory_fd = parent;
  store->lock_fd = openat(parent, LOCK_NAME, O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (store->lock_fd < 0 && errno == EEXIST) {
    store->lock_fd = openat(parent, LOCK_NAME, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  }
  if (store->lock_fd < 0) {
    fail(work, "STORE_INVALID", "open-lock", errno);
    return;
  }
  struct stat lock_status;
  if (fstat(store->lock_fd, &lock_status) != 0 || !private_regular(&lock_status)) {
    fail(work, "STORE_INVALID", "lock-ownership", errno == 0 ? EINVAL : errno);
    return;
  }
  if (flock(store->lock_fd, LOCK_EX | LOCK_NB) != 0) {
    int error_number = errno;
    fail(work, error_number == EWOULDBLOCK || error_number == EAGAIN ? "STORE_IN_USE" : "STORE_IO",
         "acquire-lock", error_number);
    return;
  }
  store->lock_device = lock_status.st_dev;
  store->lock_inode = lock_status.st_ino;
  if (!unchanged_lock(work)) return;
  /* No enrollment bytes are accessed before all lock initialization succeeds. */
  if (!full_sync(work, store->lock_fd, "lock-file-barrier")) return;
  full_sync(work, store->directory_fd, "lock-directory-barrier");
}

static bool record_metadata(Work *work, struct stat *status, bool allow_missing, bool allow_oversized) {
  if (fstatat(work->store->directory_fd, RECORD_NAME, status, AT_SYMLINK_NOFOLLOW) != 0) {
    if (allow_missing && errno == ENOENT) {
      work->missing = true;
      return true;
    }
    fail(work, "STORE_IO", "record-metadata", errno);
    return false;
  }
  if (!private_regular(status)) {
    fail(work, "STORE_INVALID", "record-ownership", EINVAL);
    return false;
  }
  if (!allow_oversized && (status->st_size < 1 || status->st_size > MAX_RECORD_BYTES)) {
    fail(work, "STORE_RECORD_TOO_LARGE", "record-size", EFBIG);
    return false;
  }
  return true;
}

static void load_record(Work *work) {
  struct stat named;
  if (!record_metadata(work, &named, true, false)) return;
  if (work->missing) {
    /* A crash after quarantine must not turn targeted recovery into first admission. */
    for (unsigned int slot = 0; slot < QUARANTINE_SLOTS; slot++) {
      char name[64];
      snprintf(name, sizeof(name), "student-session.quarantine.%u", slot);
      if (fstatat(work->store->directory_fd, name, &named, AT_SYMLINK_NOFOLLOW) == 0) {
        fail(work, "STORE_RECOVERY_REQUIRED", "preserved-recovery", EINVAL);
        return;
      }
      if (errno != ENOENT) {
        fail(work, "STORE_IO", "preserved-recovery-metadata", errno);
        return;
      }
    }
    return;
  }
  int descriptor = openat(work->store->directory_fd, RECORD_NAME, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) {
    fail(work, "STORE_IO", "open-record", errno);
    return;
  }
  struct stat actual;
  if (fstat(descriptor, &actual) != 0 || !private_regular(&actual) ||
      actual.st_dev != named.st_dev || actual.st_ino != named.st_ino || actual.st_size != named.st_size) {
    fail(work, "STORE_INVALID", "record-identity", EINVAL);
  } else {
    work->length = (size_t)actual.st_size;
    work->bytes = malloc(work->length);
    if (work->bytes == NULL) fail(work, "STORE_IO", "allocate-record", ENOMEM);
    size_t offset = 0;
    while (work->code == NULL && offset < work->length) {
      ssize_t count = read(descriptor, work->bytes + offset, work->length - offset);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) fail(work, "STORE_IO", "read-record", count < 0 ? errno : EIO);
      else offset += (size_t)count;
    }
  }
  close_descriptor(work, &descriptor, "close-record");
}

static void replace_record(Work *work) {
  struct stat current;
  if (!record_metadata(work, &current, true, false)) return;
  work->missing = false;
  unsigned char random_bytes[16];
  char temporary[80];
  const char *prefix = "student-session.pending.";
  memcpy(temporary, prefix, strlen(prefix));
  arc4random_buf(random_bytes, sizeof(random_bytes));
  for (size_t i = 0; i < sizeof(random_bytes); i++) {
    snprintf(temporary + strlen(prefix) + i * 2, 3, "%02x", random_bytes[i]);
  }
  int descriptor = openat(work->store->directory_fd, temporary,
                         O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) {
    fail(work, "STORE_IO", "create-temporary", errno);
    return;
  }
  size_t offset = 0;
  while (offset < work->length) {
    ssize_t count = write(descriptor, work->bytes + offset, work->length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      fail(work, "STORE_IO", "write-temporary", count < 0 ? errno : EIO);
      break;
    }
    offset += (size_t)count;
  }
  if (work->code == NULL) full_sync(work, descriptor, "temporary-file-barrier");
  if (work->code == NULL && unchanged_lock(work)) {
    if (renameat(work->store->directory_fd, temporary, work->store->directory_fd, RECORD_NAME) != 0) {
      fail(work, "STORE_IO", "replace-record", errno);
    } else {
      work->published = true;
      full_sync(work, work->store->directory_fd, "record-directory-barrier");
    }
  }
  close_descriptor(work, &descriptor, "close-temporary");
  if (!work->published) {
    /* Only this operation's exclusively created temporary file is removed. */
    if (unlinkat(work->store->directory_fd, temporary, 0) != 0 && errno != ENOENT)
      fail(work, "STORE_IO", "remove-temporary", errno);
  }
  if (work->code != NULL && work->published) work->poison = true;
}

static void quarantine_record(Work *work) {
  struct stat current;
  if (!record_metadata(work, &current, true, true) || work->missing) return;
  for (unsigned int slot = 0; slot < QUARANTINE_SLOTS; slot++) {
    char name[64];
    snprintf(name, sizeof(name), "student-session.quarantine.%u", slot);
    if (renameatx_np(work->store->directory_fd, RECORD_NAME,
                    work->store->directory_fd, name, RENAME_EXCL) == 0) {
      work->published = true;
      full_sync(work, work->store->directory_fd, "quarantine-directory-barrier");
      if (work->code != NULL) work->poison = true;
      return;
    }
    if (errno != EEXIST) {
      fail(work, "STORE_IO", "quarantine-record", errno);
      return;
    }
  }
  fail(work, "STORE_QUARANTINE_FULL", "quarantine-capacity", ENOSPC);
}

static void execute(napi_env env, void *data) {
  (void)env;
  Work *work = data;
  if (work->operation == OP_OPEN) {
    open_store(work);
    if (work->code != NULL) release_descriptors(work);
    return;
  }
  if (work->operation == OP_CLOSE) {
    release_descriptors(work);
    return;
  }
  if (!unchanged_lock(work)) return;
  if (work->operation == OP_LOAD) load_record(work);
  else if (work->operation == OP_REPLACE) replace_record(work);
  else if (work->operation == OP_QUARANTINE) quarantine_record(work);
  if (work->code == NULL) unchanged_lock(work);
}

/* Failure to represent a completion must never masquerade as successful storage. */
static void fatal_napi(void) {
  napi_fatal_error("durable-record", NAPI_AUTO_LENGTH,
                   "Unable to complete native storage ownership", NAPI_AUTO_LENGTH);
}

static napi_value api_failure(napi_env env) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) != napi_ok ||
      (!pending && napi_throw_error(env, "STORE_IO", "Native storage setup failed") != napi_ok))
    fatal_napi();
  return NULL;
}

static napi_value make_error(napi_env env, const char *code, const char *stage, bool published, int error_number) {
  napi_value message = NULL, error = NULL, value = NULL;
  if (napi_create_string_utf8(env, "Student session storage is unavailable", NAPI_AUTO_LENGTH, &message) != napi_ok ||
      napi_create_error(env, NULL, message, &error) != napi_ok ||
      napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, error, "code", value) != napi_ok ||
      napi_create_string_utf8(env, stage, NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, error, "stage", value) != napi_ok ||
      napi_create_string_utf8(env, published ? "possibly-published" : "not-published", NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, error, "publication", value) != napi_ok ||
      napi_create_int32(env, error_number, &value) != napi_ok ||
      napi_set_named_property(env, error, "errno", value) != napi_ok) return NULL;
  return error;
}

static napi_value rejected(napi_env env, const char *code, const char *stage, int error_number) {
  napi_deferred deferred = NULL;
  napi_value promise = NULL;
  napi_value error = make_error(env, code, stage, false, error_number);
  if (error == NULL || napi_create_promise(env, &deferred, &promise) != napi_ok)
    return api_failure(env);
  if (napi_reject_deferred(env, deferred, error) != napi_ok) fatal_napi();
  return promise;
}

static void finish_ownership(Store *store) {
  store->closed = true;
  store->busy = false;
  if (process_owner == store) process_owner = NULL;
  napi_async_cleanup_hook_handle hook = store->cleanup_hook;
  napi_ref reference = store->owner_reference;
  napi_env env = store->env;
  bool tearing_down = store->tearing_down;
  store->cleanup_hook = NULL;
  store->owner_reference = NULL;
  if (hook != NULL && napi_remove_async_cleanup_hook(hook) != napi_ok) fatal_napi();
  /* No Store access after releasing the final strong reference. */
  if (!tearing_down && reference != NULL && napi_delete_reference(env, reference) != napi_ok) fatal_napi();
}

static void cleanup(napi_async_cleanup_hook_handle hook, void *data) {
  Store *store = data;
  store->tearing_down = true;
  store->cleanup_hook = hook;
  if (!store->busy) {
    Work work = {.store = store};
    release_descriptors(&work);
    finish_ownership(store);
  }
  /* A running worker retains the lock. Its complete callback finishes cleanup. */
}

static void finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  Store *store = data;
  /* The strong owner reference and async cleanup hook make active GC impossible. */
  if (store->closed) free(store);
}

static void complete(napi_env env, napi_status status, void *data) {
  Work *work = data;
  Store *store = work->store;
  if (status != napi_ok) fail(work, "STORE_IO", "native-completion", ECANCELED);
  if (work->poison) store->poisoned = true;
  if (store->tearing_down) {
    release_descriptors(work);
    if (napi_delete_async_work(env, work->work) != napi_ok) fatal_napi();
    free(work->bytes);
    free(work);
    finish_ownership(store);
    return;
  }
  /* Keep busy reserved throughout allocation and async-resource destruction. */
  napi_value result = NULL;
  if (work->code == NULL) {
    napi_status creation;
    if (work->operation == OP_OPEN)
      creation = napi_get_reference_value(env, store->owner_reference, &result);
    else if (work->operation == OP_LOAD && !work->missing)
      creation = napi_create_buffer_copy(env, work->length, work->bytes, NULL, &result);
    else if (work->operation == OP_LOAD) creation = napi_get_null(env, &result);
    else creation = napi_get_undefined(env, &result);
    if (creation != napi_ok || result == NULL) fatal_napi();
  } else {
    result = make_error(env, work->code, work->stage, work->published, work->error_number);
    if (result == NULL) fatal_napi();
  }
  bool reject = work->code != NULL;
  bool finish = work->operation == OP_CLOSE || (work->operation == OP_OPEN && reject);
  napi_deferred deferred = work->deferred;
  if (finish) release_descriptors(work);
  if (napi_delete_async_work(env, work->work) != napi_ok) fatal_napi();
  free(work->bytes);
  free(work);
  if (finish) finish_ownership(store);
  else store->busy = false;
  /* Promise hooks can reenter only after all old work/terminal ownership is settled. */
  napi_status settled = reject ? napi_reject_deferred(env, deferred, result)
                               : napi_resolve_deferred(env, deferred, result);
  if (settled != napi_ok) fatal_napi();
}

static napi_value queue_work(napi_env env, Work *work) {
  Store *store = work->store;
  store->busy = true; /* Must precede Promise/async_hooks.init reentrancy. */
  napi_value promise = NULL, name = NULL;
  const char *stage = "create-promise";
  napi_status status = napi_create_promise(env, &work->deferred, &promise);
  if (status == napi_ok) {
    stage = "create-work";
    status = napi_create_string_utf8(env, "desmoslock-durable-record", NAPI_AUTO_LENGTH, &name);
  }
  if (status == napi_ok)
    status = napi_create_async_work(env, NULL, name, execute, complete, work, &work->work);
  if (status == napi_ok) {
    stage = "queue-work";
    status = napi_queue_async_work(env, work->work);
  }
  if (status == napi_ok) return promise;
  napi_deferred deferred = work->deferred;
  bool finish = work->operation == OP_OPEN;
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) != napi_ok) fatal_napi();
  napi_value error = pending || deferred == NULL ? NULL : make_error(env, "STORE_IO", stage, false, ENOMEM);
  if (work->work != NULL && napi_delete_async_work(env, work->work) != napi_ok) fatal_napi();
  free(work->bytes);
  free(work);
  if (finish) finish_ownership(store);
  else store->busy = false;
  if (error == NULL) return api_failure(env);
  if (napi_reject_deferred(env, deferred, error) != napi_ok) fatal_napi();
  return promise;
}

static napi_value method(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value arguments[2], receiver;
  void *operation_data;
  if (napi_get_cb_info(env, info, &count, arguments, &receiver, &operation_data) != napi_ok)
    return rejected(env, "STORE_INVALID", "arguments", EINVAL);
  Operation operation = (Operation)(uintptr_t)operation_data;
  bool tagged = false;
  Store *store = NULL;
  if (!pthread_main_np() || napi_check_object_type_tag(env, receiver, &store_tag, &tagged) != napi_ok ||
      !tagged || napi_unwrap(env, receiver, (void **)&store) != napi_ok || store == NULL)
    return rejected(env, "STORE_INVALID", "store-handle", EINVAL);
  if (store->closed || store->tearing_down) return rejected(env, "STORE_CLOSED", "store-lifetime", EBADF);
  if (store->busy) return rejected(env, "STORE_BUSY", "store-operation", EBUSY);
  if (store->poisoned && operation != OP_CLOSE)
    return rejected(env, "STORE_INVALID", "storage-recovery-required", EIO);
  if (count != (operation == OP_REPLACE ? 1u : 0u))
    return rejected(env, "STORE_INVALID", "arguments", EINVAL);
  Work *work = calloc(1, sizeof(*work));
  if (work == NULL) return rejected(env, "STORE_IO", "allocate-work", ENOMEM);
  work->store = store;
  work->operation = operation;
  if (operation == OP_REPLACE) {
    bool is_buffer = false;
    bool ordinary_array_buffer = false;
    void *bytes = NULL;
    napi_typedarray_type array_type;
    napi_value backing_buffer;
    size_t array_length, byte_offset;
    if (napi_is_buffer(env, arguments[0], &is_buffer) != napi_ok || !is_buffer ||
        napi_get_buffer_info(env, arguments[0], &bytes, &work->length) != napi_ok ||
        napi_get_typedarray_info(env, arguments[0], &array_type, &array_length, &bytes,
                                &backing_buffer, &byte_offset) != napi_ok ||
        napi_is_arraybuffer(env, backing_buffer, &ordinary_array_buffer) != napi_ok ||
        !ordinary_array_buffer || array_type != napi_uint8_array ||
        work->length < 1 || work->length > MAX_RECORD_BYTES) {
      free(work);
      return rejected(env, "STORE_INVALID", "ciphertext-bounds", EINVAL);
    }
    work->bytes = malloc(work->length);
    if (work->bytes == NULL) {
      free(work);
      return rejected(env, "STORE_IO", "snapshot-ciphertext", ENOMEM);
    }
    memcpy(work->bytes, bytes, work->length);
  }
  return queue_work(env, work);
}

static bool valid_directory(const char *directory, size_t length) {
  if (length < 2 || length >= PATH_MAX || directory[0] != '/' || strlen(directory) != length ||
      directory[length - 1] == '/') return false;
  const char *component = directory + 1;
  for (size_t i = 1; i <= length; i++) {
    if (directory[i] == '/' || directory[i] == '\0') {
      size_t size = (size_t)(directory + i - component);
      if (size == 0 || (size == 1 && component[0] == '.') ||
          (size == 2 && component[0] == '.' && component[1] == '.')) return false;
      component = directory + i + 1;
    }
  }
  return true;
}

static napi_value open_method(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value arguments[2];
  if (!pthread_main_np()) return rejected(env, "STORE_INVALID", "main-thread-required", EINVAL);
  if (process_owner != NULL) return rejected(env, "STORE_IN_USE", "process-store-owner", EWOULDBLOCK);
  if (napi_get_cb_info(env, info, &count, arguments, NULL, NULL) != napi_ok) return api_failure(env);
  napi_valuetype type;
  if (count != 1 || napi_typeof(env, arguments[0], &type) != napi_ok || type != napi_string)
    return rejected(env, "STORE_INVALID", "owned-directory", EINVAL);
  Work *work = calloc(1, sizeof(*work));
  Store *store = calloc(1, sizeof(*store));
  if (work == NULL || store == NULL) {
    free(work);
    free(store);
    return rejected(env, "STORE_IO", "allocate-store", ENOMEM);
  }
  size_t length = 0;
  if (napi_get_value_string_utf8(env, arguments[0], NULL, 0, &length) != napi_ok || length >= PATH_MAX || napi_get_value_string_utf8(env, arguments[0], work->directory,
      sizeof(work->directory), &length) != napi_ok || !valid_directory(work->directory, length)) {
    free(work);
    free(store);
    return rejected(env, "STORE_INVALID", "owned-directory", EINVAL);
  }
  store->env = env;
  store->directory_fd = -1;
  store->lock_fd = -1;
  work->store = store;
  work->operation = OP_OPEN;
  store->busy = true;
  process_owner = store; /* Reserve singleton before hook-capable setup. */
  napi_value object = NULL;
  bool wrapped = false;
  const napi_property_descriptor properties[] = {
    {"loadEncryptedRecord", NULL, method, NULL, NULL, NULL, napi_default, (void *)(uintptr_t)OP_LOAD},
    {"replaceEncryptedRecord", NULL, method, NULL, NULL, NULL, napi_default, (void *)(uintptr_t)OP_REPLACE},
    {"quarantineEncryptedRecord", NULL, method, NULL, NULL, NULL, napi_default, (void *)(uintptr_t)OP_QUARANTINE},
    {"close", NULL, method, NULL, NULL, NULL, napi_default, (void *)(uintptr_t)OP_CLOSE},
  };
  napi_status setup = napi_create_object(env, &object);
  if (setup == napi_ok) setup = napi_define_properties(env, object, sizeof(properties) / sizeof(properties[0]), properties);
  if (setup == napi_ok) setup = napi_type_tag_object(env, object, &store_tag);
  if (setup == napi_ok) {
    setup = napi_wrap(env, object, store, finalize, NULL, NULL);
    wrapped = setup == napi_ok;
  }
  if (setup == napi_ok) setup = napi_create_reference(env, object, 1, &store->owner_reference);
  if (setup == napi_ok) setup = napi_add_async_cleanup_hook(env, cleanup, store, &store->cleanup_hook);
  if (setup != napi_ok) {
    free(work);
    finish_ownership(store);
    if (!wrapped) free(store);
    return api_failure(env);
  }
  return queue_work(env, work);
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value method_value = NULL, size_value = NULL;
  if (napi_create_function(env, "openStore", NAPI_AUTO_LENGTH, open_method, NULL, &method_value) != napi_ok ||
      napi_set_named_property(env, exports, "openStore", method_value) != napi_ok ||
      napi_create_uint32(env, MAX_RECORD_BYTES, &size_value) != napi_ok ||
      napi_set_named_property(env, exports, "maximumRecordBytes", size_value) != napi_ok)
    return api_failure(env);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
