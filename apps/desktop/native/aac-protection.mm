#if !defined(__APPLE__)
#error "AAC protection is available only on macOS; there is no simulated fallback."
#endif
#import <AppKit/AppKit.h>
#import <AutomaticAssessmentConfiguration/AutomaticAssessmentConfiguration.h>
#import <Foundation/Foundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/pwr_mgt/IOPM.h>
#include <dispatch/dispatch.h>
#include <node_api.h>
#include <atomic>
#include <new>
#include <memory>
#include <cstring>
#include <pthread.h>
#include <string>
#include "aac-protection-state.h"
#include "aac-boot-session.h"

using namespace desmoslock::aac;
@class DLAssessmentOwner;
struct ModuleContext {
  napi_env env = nullptr;
  __strong DLAssessmentOwner *owner = nil;
  bool busy = false;
  bool closing = false;
};
static ModuleContext *processContext = nullptr;
// A closing JS environment may not discard uncertain OS ownership.
static DLAssessmentOwner *orphanedOwner = nil;
static char workspaceObservationContext, applicationObservationContext;

@interface DLAssessmentDelegate : NSObject <AEAssessmentSessionDelegate>
@property(nonatomic, weak) DLAssessmentOwner *owner;
@end
@interface DLObservedApplication : NSObject
@property(nonatomic, strong) NSRunningApplication *application;
@property(nonatomic) unsigned int mask;
@end
@implementation DLObservedApplication
@end

@interface DLAssessmentOwner : NSObject {
 @public
  Lifecycle state;
  std::atomic<bool> offMainInvalidated;
  napi_threadsafe_function lifecycleCallback;
  napi_threadsafe_function applicationCallback;
  uint64_t applicationSequence;
  uint64_t lifecycleSubscription;
  uint64_t applicationSubscription;
  uint64_t timerGeneration;
  ApplicationStatus applicationStatus;
  const char *applicationReason;
  bool observationFault;
  bool observing;
  bool refreshing;
  bool containmentFault;
  bool disposed;
  bool environmentClosed;
}
@property(nonatomic, strong) AEAssessmentSession *session;
@property(nonatomic, strong) DLAssessmentDelegate *delegate;
@property(nonatomic, copy) NSString *attempt;
@property(nonatomic, strong) NSWorkspace *workspace;
@property(nonatomic, strong) NSMutableArray<DLObservedApplication *> *applications;
@property(nonatomic, strong) dispatch_source_t watchdog;
- (void)apply:(Effects)effects;
- (void)invalidate;
- (void)hideWindows;
- (void)stopWatchdog;
- (void)armWatchdog;
- (void)endNative;
- (void)emit:(Event)event sequence:(uint64_t)sequence;
- (void)receive:(Event)event session:(AEAssessmentSession *)session;
- (BOOL)startObservation;
- (BOOL)stopObservation;
- (void)refreshApplications;
- (void)setApplicationStatus:(ApplicationStatus)status reason:(const char *)reason;
- (BOOL)usable:(uint64_t)sequence;
- (BOOL)dispose;
- (void)environmentClosing;
@end

struct Delivery {
  __strong DLAssessmentOwner *owner = nil;
  Event event = Event::none;
  uint64_t sequence = 0;
  bool application = false;
  ApplicationStatus status = ApplicationStatus::unavailable;
  const char *reason = "unavailable";
};
struct CallbackContext {
  __strong DLAssessmentOwner *owner = nil;
  bool application = false;
  uint64_t generation = 0;
};
struct Subscription {
  __strong DLAssessmentOwner *owner = nil;
  bool application = false;
  bool released = false;
  uint64_t generation = 0;
};
struct NapiFailure {};
static void checked(napi_status status) { if (status != napi_ok) throw NapiFailure{}; }
static napi_value text(napi_env env, const char *value) {
  napi_value result = nullptr;
  checked(napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result));
  return result;
}
static void property(napi_env env, napi_value object, const char *key, napi_value value) {
  checked(napi_set_named_property(env, object, key, value));
}
static napi_value boolean(napi_env env, bool value) {
  napi_value result = nullptr;
  checked(napi_get_boolean(env, value, &result));
  return result;
}
static napi_value exception(napi_env env, const char *code) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) != napi_ok ||
      (!pending && napi_throw_error(env, code, "Native assessment operation unavailable") != napi_ok))
    napi_fatal_error("aac-protection", NAPI_AUTO_LENGTH, "Native assessment exception unavailable", NAPI_AUTO_LENGTH);
  return nullptr;
}
static void clearException(napi_env env) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
    napi_value ignored = nullptr;
    (void)napi_get_and_clear_last_exception(env, &ignored);
  }
}
static const char *eventName(Event event) {
  switch (event) {
    case Event::didBegin: return "did_begin";
    case Event::failedToBegin: return "failed_to_begin";
    case Event::interrupted: return "interrupted";
    case Event::didEnd: return "did_end";
    default: return "invalid";
  }
}
static const char *statusName(ApplicationStatus status) {
  switch (status) {
    case ApplicationStatus::clear: return "clear";
    case ApplicationStatus::blocked: return "blocked";
    default: return "unavailable";
  }
}
static napi_value applicationResult(napi_env env, ApplicationStatus status, const char *reason) {
  napi_value result = nullptr;
  checked(napi_create_object(env, &result));
  property(env, result, "status", text(env, statusName(status)));
  property(env, result, "reason", text(env, reason));
  return result;
}
static void releaseCallback(napi_threadsafe_function *slot) {
  napi_threadsafe_function callback = *slot;
  *slot = nullptr;
  if (callback != nullptr) {
    napi_status status = napi_release_threadsafe_function(callback, napi_tsfn_abort);
    if (status != napi_ok && status != napi_closing)
      napi_fatal_error("aac-protection", NAPI_AUTO_LENGTH, "Native callback ownership unavailable", NAPI_AUTO_LENGTH);
  }
}
static void delivery(napi_env env, napi_value callback, void *context, void *data) {
  std::unique_ptr<Delivery> payload(static_cast<Delivery *>(data));
  if (env == nullptr || callback == nullptr || payload == nullptr) return;
  DLAssessmentOwner *owner = payload->owner;
  if (owner == nil || owner->environmentClosed || owner->disposed) return;
  const auto *subscription = static_cast<CallbackContext *>(context);
  if (subscription == nullptr || subscription->generation !=
      (subscription->application ? owner->applicationSubscription : owner->lifecycleSubscription)) return;
  if (payload->application) {
    if (!owner->observing || owner->applicationCallback == nullptr) return;
    // A queued clear status cannot outlive an intervening policy failure.
    if (payload->status == ApplicationStatus::clear &&
        (payload->sequence != owner->applicationSequence ||
         owner->applicationStatus != ApplicationStatus::clear || owner->observationFault ||
         owner->offMainInvalidated.load())) return;
  } else if (payload->event == Event::didBegin && ![owner usable:payload->sequence]) return;
  try {
    napi_value value = nullptr;
    if (payload->application) value = applicationResult(env, payload->status, payload->reason);
    else {
      checked(napi_create_object(env, &value));
      property(env, value, "type", text(env, eventName(payload->event)));
      property(env, value, "attemptId", text(env, owner.attempt.UTF8String));
      napi_value sequence = nullptr;
      checked(napi_create_double(env, static_cast<double>(payload->sequence), &sequence));
      property(env, value, "sequence", sequence);
      const char *code = owner->containmentFault ? "content_hide_failed" :
        payload->event == Event::failedToBegin ? "native_failed_to_begin" :
        payload->event == Event::interrupted ? "native_interrupted" : "none";
      property(env, value, "code", text(env, code));
    }
    napi_value receiver = nullptr, ignored = nullptr;
    checked(napi_get_undefined(env, &receiver));
    // N-API object construction can reenter through user-modified JS prototypes.
    // Fence once more at the exact delivery boundary, after all such work.
    if (owner->disposed || owner->environmentClosed || subscription->generation !=
        (subscription->application ? owner->applicationSubscription : owner->lifecycleSubscription)) return;
    if (payload->application && (!owner->observing || owner->applicationCallback == nullptr)) return;
    if (payload->application && payload->status == ApplicationStatus::clear &&
        (payload->sequence != owner->applicationSequence || owner->observationFault ||
         owner->offMainInvalidated.load() || owner->applicationStatus != ApplicationStatus::clear)) return;
    if (!payload->application && payload->event == Event::didBegin && ![owner usable:payload->sequence]) return;
    checked(napi_call_function(env, receiver, callback, 1, &value, &ignored));
  } catch (...) {
    clearException(env); // Never forward listener content or native error details.
    owner->offMainInvalidated.store(true); // Includes failures before an attempt exists.
    if (payload->application) owner->observationFault = true;
    [owner invalidate];
  }
}
static void finalizeCallback(napi_env, void *data, void *) {
  delete static_cast<CallbackContext *>(data);
}
static napi_threadsafe_function makeCallback(napi_env env, napi_value listener, DLAssessmentOwner *owner,
                                             bool application, uint64_t generation) {
  std::unique_ptr<CallbackContext> context(new CallbackContext{owner, application, generation});
  napi_threadsafe_function result = nullptr;
  checked(napi_create_threadsafe_function(env, listener, nullptr, text(env, "desmoslock-aac"),
    16, 1, context.get(), finalizeCallback, context.get(), delivery, &result));
  context.release();
  return result;
}
static void queue(napi_threadsafe_function *slot, Delivery *raw) {
  std::unique_ptr<Delivery> payload(raw);
  DLAssessmentOwner *owner = payload->owner;
  const napi_threadsafe_function callback = *slot;
  if (callback == nullptr || owner->environmentClosed || owner->disposed) {
    owner->offMainInvalidated.store(true);
    if (payload->application) owner->observationFault = true;
    [owner invalidate];
    return;
  }
  napi_status status = napi_call_threadsafe_function(callback, payload.get(), napi_tsfn_nonblocking);
  if (status == napi_ok) payload.release();
  else {
    // Node-API forbids any later use, including release, after napi_closing.
    if (status == napi_closing && *slot == callback) *slot = nullptr;
    owner->offMainInvalidated.store(true);
    if (payload->application) owner->observationFault = true;
    [owner invalidate]; // Includes saturation/closing: no reliance on another JS callback.
  }
}

struct NativeEffects {
  __strong DLAssessmentOwner *owner;
  void hide() { [owner hideWindows]; }
  void stopWatchdog() { [owner stopWatchdog]; }
  void armWatchdog() { [owner armWatchdog]; }
  void end() { [owner endNative]; }
  void emit(Event event, uint64_t sequence) { [owner emit:event sequence:sequence]; }
};

@implementation DLAssessmentOwner
- (instancetype)init {
  self = [super init];
  if (self) {
    offMainInvalidated.store(false);
    applicationStatus = ApplicationStatus::unavailable;
    applicationReason = "observation_not_started";
    self.applications = [NSMutableArray array];
  }
  return self;
}
- (BOOL)usable:(uint64_t)sequence {
  return !disposed && !environmentClosed && !containmentFault &&
    !offMainInvalidated.load() && state.activeAt(sequence);
}
- (void)apply:(Effects)effects {
  NativeEffects sink{self};
  perform(effects, sink);
}
- (void)invalidate {
  [self apply:state.fault()];
}
- (void)hideWindows {
  @try {
    if (NSApp == nil) { containmentFault = true; return; }
    NSArray<NSWindow *> *windows = NSApp.windows;
    for (NSWindow *window in windows) {
      @try { [window orderOut:nil]; }
      @catch (NSException *) { containmentFault = true; }
    }
  } @catch (NSException *) { containmentFault = true; }
}
- (void)stopWatchdog {
  ++timerGeneration;
  if (self.watchdog != nil) {
    dispatch_source_cancel(self.watchdog);
    self.watchdog = nil;
  }
}
- (void)armWatchdog {
  [self stopWatchdog];
  const uint64_t generation = timerGeneration;
  dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  if (timer == nil) { offMainInvalidated.store(true); [self invalidate]; return; }
  self.watchdog = timer;
  __weak DLAssessmentOwner *weakOwner = self;
  dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC), DISPATCH_TIME_FOREVER, 0);
  dispatch_source_set_event_handler(timer, ^{
    DLAssessmentOwner *owner = weakOwner;
    if (owner != nil && owner->timerGeneration == generation && !owner->disposed) {
      [owner stopWatchdog];
      [owner apply:owner->state.timeout()];
    }
  });
  dispatch_resume(timer);
}
- (void)endNative {
  @try { [self.session end]; }
  @catch (NSException *) { [self invalidate]; }
}
- (void)emit:(Event)event sequence:(uint64_t)sequence {
  if (environmentClosed) return;
  try { queue(&lifecycleCallback, new Delivery{self, event, sequence}); }
  catch (...) { [self invalidate]; }
}
- (void)receive:(Event)event session:(AEAssessmentSession *)session {
  if (!pthread_main_np()) {
    offMainInvalidated.store(true);
    dispatch_async(dispatch_get_main_queue(), ^{
      if (!self->disposed) { [self invalidate]; [self receive:event session:session]; }
    });
    return;
  }
  if (session != self.session || disposed) return;
  Effects effects;
  switch (event) {
    case Event::didBegin: effects = state.didBegin(); break;
    case Event::failedToBegin: effects = state.failedToBegin(); break;
    case Event::interrupted: effects = state.interrupted(); break;
    case Event::didEnd: effects = state.didEnd(); break;
    default: return;
  }
  [self apply:effects];
}
- (void)setApplicationStatus:(ApplicationStatus)status reason:(const char *)reason {
  if (observationFault) { status = ApplicationStatus::unavailable; reason = "observation_failed"; }
  bool changed = status != applicationStatus || strcmp(reason, applicationReason) != 0;
  applicationStatus = status;
  applicationReason = reason;
  if (status != ApplicationStatus::clear) [self invalidate];
  if (!changed || environmentClosed || disposed) return;
  if (applicationSequence >= maximumSequence) {
    observationFault = true;
    applicationStatus = ApplicationStatus::unavailable;
    applicationReason = "observation_failed";
    [self invalidate];
    return;
  }
  ++applicationSequence;
  try {
    queue(&applicationCallback, new Delivery{self, Event::none, applicationSequence, true, status, reason});
  } catch (...) { observationFault = true; [self invalidate]; }
}
- (BOOL)startObservation {
  if (observing || disposed || observationFault) return NO;
  @try {
    self.workspace = NSWorkspace.sharedWorkspace;
    if (self.workspace == nil) return NO;
    // Install array observation before obtaining any running-application snapshot.
    observing = true; // An exception during registration leaves observer ownership uncertain.
    [self.workspace addObserver:self forKeyPath:@"runningApplications" options:0 context:&workspaceObservationContext];
    [self refreshApplications];
    return !observationFault;
  } @catch (NSException *) {
    observationFault = true;
    [self setApplicationStatus:ApplicationStatus::unavailable reason:"observation_failed"];
    return NO;
  }
}
- (BOOL)stopObservation {
  bool success = true;
  NSArray<NSString *> *keys = @[@"activationPolicy", @"terminated", @"finishedLaunching", @"processIdentifier"];
  for (DLObservedApplication *entry in [self.applications copy]) {
    for (NSUInteger i = 0; i < keys.count; ++i) {
      if ((entry.mask & (1U << i)) == 0) continue;
      @try {
        [entry.application removeObserver:self forKeyPath:keys[i] context:&applicationObservationContext];
        entry.mask &= ~(1U << i);
      } @catch (NSException *) { success = false; }
    }
    if (entry.mask == 0) [self.applications removeObject:entry];
  }
  if (observing) {
    @try {
      [self.workspace removeObserver:self forKeyPath:@"runningApplications" context:&workspaceObservationContext];
      observing = false;
    } @catch (NSException *) { success = false; }
  }
  if (!success) { observationFault = true; [self invalidate]; }
  return success;
}
- (void)refreshApplications {
  if (!pthread_main_np()) {
    offMainInvalidated.store(true);
    dispatch_async(dispatch_get_main_queue(), ^{
      self->observationFault = true;
      [self setApplicationStatus:ApplicationStatus::unavailable reason:"observation_failed"];
    });
    return;
  }
  if (!observing || disposed || observationFault) return;
  if (refreshing) {
    observationFault = true;
    [self setApplicationStatus:ApplicationStatus::unavailable reason:"observation_failed"];
    return;
  }
  refreshing = true;
  @try {
    NSArray<NSRunningApplication *> *snapshot = self.workspace.runningApplications;
    if (snapshot == nil || snapshot.count > 512) @throw [NSException exceptionWithName:@"Policy" reason:nil userInfo:nil];
    NSArray<NSString *> *keys = @[@"activationPolicy", @"terminated", @"finishedLaunching", @"processIdentifier"];
    for (NSRunningApplication *app in snapshot) {
      DLObservedApplication *existing = nil;
      for (DLObservedApplication *entry in self.applications)
        if ([entry.application isEqual:app]) { existing = entry; break; }
      if (existing == nil) {
        existing = [DLObservedApplication new];
        existing.application = app;
        [self.applications addObject:existing];
        for (NSUInteger i = 0; i < keys.count; ++i) {
          existing.mask |= 1U << i;
          [app addObserver:self forKeyPath:keys[i] options:0 context:&applicationObservationContext];
        }
      }
    }
    for (DLObservedApplication *entry in [self.applications copy]) {
      if ([snapshot containsObject:entry.application]) continue;
      for (NSUInteger i = 0; i < keys.count; ++i) {
        if ((entry.mask & (1U << i)) != 0) {
          [entry.application removeObserver:self forKeyPath:keys[i] context:&applicationObservationContext];
          entry.mask &= ~(1U << i);
        }
      }
      [self.applications removeObject:entry];
    }
    NSRunningApplication *own = NSRunningApplication.currentApplication;
    ApplicationStatus result = ApplicationStatus::clear;
    if (own == nil || ![snapshot containsObject:own]) result = ApplicationStatus::unavailable;
    for (NSRunningApplication *app in snapshot) {
      Activation activation = Activation::unknown;
      switch (app.activationPolicy) {
        case NSApplicationActivationPolicyRegular: activation = Activation::regular; break;
        case NSApplicationActivationPolicyAccessory: activation = Activation::accessory; break;
        case NSApplicationActivationPolicyProhibited: activation = Activation::prohibited; break;
      }
      const bool identity = app.bundleIdentifier.length > 0 && app.bundleURL.isFileURL &&
        app.executableURL.isFileURL && app.processIdentifier > 0 && app.finishedLaunching && !app.terminated;
      const bool finder = [app.bundleIdentifier isEqualToString:@"com.apple.finder"] &&
        [app.bundleURL.path isEqualToString:@"/System/Library/CoreServices/Finder.app"] &&
        [app.executableURL.path isEqualToString:@"/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"];
      ApplicationStatus current = classify({activation, identity, [app isEqual:own] != NO, finder});
      if (current == ApplicationStatus::unavailable) result = current;
      else if (current == ApplicationStatus::blocked && result == ApplicationStatus::clear) result = current;
    }
    [self setApplicationStatus:result reason:result == ApplicationStatus::clear ? "policy_clear" :
      result == ApplicationStatus::blocked ? "prohibited_application" : "application_identity_unavailable"];
  } @catch (NSException *) {
    observationFault = true;
    [self setApplicationStatus:ApplicationStatus::unavailable reason:"observation_failed"];
  }
  refreshing = false;
}
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
  if (context == &workspaceObservationContext || context == &applicationObservationContext) [self refreshApplications];
  else [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
}
- (BOOL)dispose {
  if (disposed) return YES;
  if (!state.canDispose() || ![self stopObservation]) return NO;
  disposed = true;
  [self stopWatchdog];
  self.session.delegate = nil;
  self.session = nil;
  self.delegate = nil;
  releaseCallback(&lifecycleCallback);
  releaseCallback(&applicationCallback);
  return YES;
}
- (void)environmentClosing {
  environmentClosed = true;
  [self invalidate];
  releaseCallback(&lifecycleCallback);
  releaseCallback(&applicationCallback);
  if (state.canDispose()) (void)[self dispose];
}
@end

@implementation DLAssessmentDelegate
- (void)assessmentSessionDidBegin:(AEAssessmentSession *)session { [self.owner receive:Event::didBegin session:session]; }
- (void)assessmentSession:(AEAssessmentSession *)session failedToBeginWithError:(NSError *)error {
  (void)error; [self.owner receive:Event::failedToBegin session:session];
}
- (void)assessmentSession:(AEAssessmentSession *)session wasInterruptedWithError:(NSError *)error {
  (void)error; [self.owner receive:Event::interrupted session:session];
}
- (void)assessmentSessionDidEnd:(AEAssessmentSession *)session { [self.owner receive:Event::didEnd session:session]; }
@end

struct BusyGuard {
  ModuleContext *context;
  explicit BusyGuard(ModuleContext *value): context(value) {
    if (context->busy || context->closing) throw NapiFailure{};
    context->busy = true;
  }
  ~BusyGuard() { context->busy = false; }
};
struct BootSessionIO {
  CFMutableDictionaryRef matching() { return IOServiceMatching("IOPMrootDomain"); }
  io_service_t service(CFMutableDictionaryRef value) {
    return IOServiceGetMatchingService(kIOMainPortDefault, value);
  }
  CFTypeRef property(io_service_t value) {
    return IORegistryEntryCreateCFProperty(value, CFSTR(kIOPMBootSessionUUIDKey), kCFAllocatorDefault, 0);
  }
  bool isString(CFTypeRef value) { return CFGetTypeID(value) == CFStringGetTypeID(); }
  CFIndex length(CFTypeRef value) { return CFStringGetLength(static_cast<CFStringRef>(value)); }
  bool ascii(CFTypeRef value, char *output, size_t capacity) {
    return CFStringGetCString(static_cast<CFStringRef>(value), output,
                             static_cast<CFIndex>(capacity), kCFStringEncodingASCII);
  }
  void releaseService(io_service_t value) { (void)IOObjectRelease(value); }
  void releaseProperty(CFTypeRef value) { CFRelease(value); }
};
static napi_value readBootSessionId(napi_env env, napi_callback_info info) {
  try {
    size_t count = 1;
    napi_value ignored = nullptr;
    checked(napi_get_cb_info(env, info, &count, &ignored, nullptr, nullptr));
    if (count != 0 || !pthread_main_np() || processContext == nullptr ||
        processContext->env != env) throw NapiFailure{};
    BusyGuard guard(processContext);
    BootSessionIO io;
    std::array<char, 37> value{};
    if (!readBootSession(io, value)) throw NapiFailure{};
    return text(env, value.data());
  } catch (...) { return exception(env, "AAC_BOOT_SESSION_UNAVAILABLE"); }
}
enum class Method { inspect, begin, requestEnd, subscribe, dispose, readApplications, observeApplications, isActive };
static std::string attemptValue(napi_env env, napi_value value) {
  napi_valuetype type;
  checked(napi_typeof(env, value, &type));
  if (type != napi_string) throw NapiFailure{};
  size_t length = 0;
  checked(napi_get_value_string_utf8(env, value, nullptr, 0, &length));
  if (length != 36) throw NapiFailure{};
  char bytes[37] = {};
  checked(napi_get_value_string_utf8(env, value, bytes, sizeof(bytes), &length));
  if (!canonicalAttempt(std::string_view(bytes, length))) throw NapiFailure{};
  return std::string(bytes, length);
}
static DLAssessmentOwner *ensureOwner(ModuleContext *context) {
  if (context->owner == nil) {
    context->owner = [DLAssessmentOwner new];
    if (context->owner == nil) throw NapiFailure{};
  }
  return context->owner;
}
static void finalizeSubscription(napi_env, void *data, void *) { delete static_cast<Subscription *>(data); }
static napi_value unsubscribe(napi_env env, napi_callback_info info) {
  try {
    size_t count = 0;
    void *data = nullptr;
    checked(napi_get_cb_info(env, info, &count, nullptr, nullptr, &data));
    if (!pthread_main_np() || count != 0 || processContext == nullptr || processContext->env != env) throw NapiFailure{};
    BusyGuard guard(processContext);
    auto *subscription = static_cast<Subscription *>(data);
    DLAssessmentOwner *owner = subscription->owner;
    if (subscription->released || owner->disposed) return boolean(env, true);
    if (subscription->generation != (subscription->application ? owner->applicationSubscription : owner->lifecycleSubscription)) {
      subscription->released = true;
      return boolean(env, true);
    }
    if (!owner->state.canDispose()) throw NapiFailure{};
    if (subscription->application && ![owner stopObservation]) throw NapiFailure{};
    releaseCallback(subscription->application ? &owner->applicationCallback : &owner->lifecycleCallback);
    subscription->released = true; // An old disposer cannot abort a later subscription.
    return boolean(env, true);
  } catch (...) { return exception(env, "AAC_SUBSCRIPTION_RETAINED"); }
}
static napi_value subscribe(napi_env env, napi_value listener, DLAssessmentOwner *owner, bool application) {
  napi_valuetype type;
  checked(napi_typeof(env, listener, &type));
  if (type != napi_function) throw NapiFailure{};
  napi_threadsafe_function *slot = application ? &owner->applicationCallback : &owner->lifecycleCallback;
  if (*slot != nullptr) throw NapiFailure{};
  uint64_t *generation = application ? &owner->applicationSubscription : &owner->lifecycleSubscription;
  if (*generation >= maximumSequence) throw NapiFailure{};
  ++*generation;
  std::unique_ptr<Subscription> token(new Subscription{owner, application, false, *generation});
  napi_value disposer = nullptr;
  checked(napi_create_function(env, "unsubscribe", NAPI_AUTO_LENGTH, unsubscribe, token.get(), &disposer));
  checked(napi_add_finalizer(env, disposer, token.get(), finalizeSubscription, nullptr, nullptr));
  token.release();
  *slot = makeCallback(env, listener, owner, application, *generation);
  if (application && ![owner startObservation]) {
    // Keep an uncertain observer/owner retained for explicit disposal.
    throw NapiFailure{};
  }
  return disposer;
}
static napi_value method(napi_env env, napi_callback_info info) {
  try {
    size_t count = 3;
    napi_value args[3] = {};
    void *data = nullptr;
    checked(napi_get_cb_info(env, info, &count, args, nullptr, &data));
    if (!pthread_main_np() || processContext == nullptr || processContext->env != env) throw NapiFailure{};
    ModuleContext *context = processContext;
    BusyGuard guard(context);
    Method action = static_cast<Method>(reinterpret_cast<uintptr_t>(data));
    const size_t expected = action == Method::isActive ? 2 :
      (action == Method::begin || action == Method::requestEnd || action == Method::subscribe || action == Method::observeApplications ? 1 : 0);
    if (count != expected) throw NapiFailure{};
    if (action == Method::inspect) {
      napi_value result = nullptr;
      checked(napi_create_object(env, &result));
      bool available = false;
      if (@available(macOS 12.0, *))
        available = NSClassFromString(@"AEAssessmentSession") != nil && NSClassFromString(@"AEAssessmentConfiguration") != nil;
      property(env, result, "available", boolean(env, available));
      property(env, result, "reason", text(env, available ? "api_available_authorization_unverified" : "api_unavailable"));
      return result;
    }
    if (action == Method::isActive) {
      const std::string attempt = attemptValue(env, args[0]);
      napi_valuetype type;
      checked(napi_typeof(env, args[1], &type));
      if (type != napi_number) return boolean(env, false);
      double value = 0;
      checked(napi_get_value_double(env, args[1], &value));
      DLAssessmentOwner *owner = context->owner;
      return boolean(env, canonicalSequence(value) && owner != nil &&
        [owner.attempt isEqualToString:[NSString stringWithUTF8String:attempt.c_str()]] &&
        [owner usable:static_cast<uint64_t>(value)]);
    }
    if (action == Method::dispose) {
      DLAssessmentOwner *owner = context->owner;
      if (owner != nil && ![owner dispose]) throw NapiFailure{};
      context->owner = nil;
      return boolean(env, true);
    }
    if (action == Method::subscribe || action == Method::observeApplications)
      return subscribe(env, args[0], ensureOwner(context), action == Method::observeApplications);
    if (action == Method::readApplications) {
      DLAssessmentOwner *owner = context->owner;
      if (owner == nil || !owner->observing)
        return applicationResult(env, ApplicationStatus::unavailable, "observation_not_started");
      if (owner->observationFault || owner->offMainInvalidated.load())
        return applicationResult(env, ApplicationStatus::unavailable, "observation_failed");
      [owner refreshApplications];
      if (owner->observationFault || owner->offMainInvalidated.load())
        return applicationResult(env, ApplicationStatus::unavailable, "observation_failed");
      return applicationResult(env, owner->applicationStatus, owner->applicationReason);
    }
    const std::string attempt = attemptValue(env, args[0]);
    DLAssessmentOwner *owner = context->owner;
    NSString *identifier = [NSString stringWithUTF8String:attempt.c_str()];
    if (owner == nil) throw NapiFailure{};
    if (owner.attempt != nil) {
      if (![owner.attempt isEqualToString:identifier]) throw NapiFailure{};
      if (action == Method::requestEnd) [owner apply:owner->state.requestEnd()];
      return boolean(env, true); // Same-attempt calls coalesce, never start a second session.
    }
    if (action != Method::begin || owner->lifecycleCallback == nullptr || !owner->observing ||
        owner->observationFault || NSApp == nil) throw NapiFailure{};
    [owner refreshApplications];
    if (owner->applicationStatus != ApplicationStatus::clear || owner->observationFault ||
        owner->offMainInvalidated.load() || !owner->observing || owner->applicationCallback == nullptr)
      throw NapiFailure{};
    owner.attempt = identifier;
    [owner apply:owner->state.start()];
    bool invoked = false;
    @try {
      if (owner->state.cancelled || owner->offMainInvalidated.load())
        @throw [NSException exceptionWithName:@"Watchdog" reason:nil userInfo:nil];
      if (@available(macOS 12.0, *)) {
        AEAssessmentConfiguration *configuration = [AEAssessmentConfiguration new];
        if (configuration == nil || configuration.mainParticipantConfiguration == nil ||
            configuration.configurationsByApplication.count != 0) @throw [NSException exceptionWithName:@"Configuration" reason:nil userInfo:nil];
        configuration.mainParticipantConfiguration.allowsNetworkAccess = YES;
        owner.delegate = [DLAssessmentDelegate new];
        owner.delegate.owner = owner;
        owner.session = [[AEAssessmentSession alloc] initWithConfiguration:configuration];
        if (owner.session == nil || owner.delegate == nil) @throw [NSException exceptionWithName:@"Session" reason:nil userInfo:nil];
        owner.session.delegate = owner.delegate;
        invoked = true; // Exceptions from here retain uncertain OS ownership.
        [owner.session begin];
      } else @throw [NSException exceptionWithName:@"Unavailable" reason:nil userInfo:nil];
    } @catch (NSException *) {
      [owner apply:invoked ? owner->state.fault() : owner->state.preparationFailed()];
      throw NapiFailure{};
    }
    return boolean(env, true);
  } catch (...) { return exception(env, "AAC_OPERATION_UNAVAILABLE"); }
}
static void cleanup(void *data) {
  auto *context = static_cast<ModuleContext *>(data);
  context->closing = true;
  DLAssessmentOwner *owner = context->owner;
  if (owner != nil) {
    [owner environmentClosing];
    if (!owner->disposed) orphanedOwner = owner;
    context->owner = nil;
  }
  processContext = nullptr;
  delete context;
}
static napi_value initialize(napi_env env, napi_value exports) {
  try {
    if (!pthread_main_np() || processContext != nullptr || orphanedOwner != nil) throw NapiFailure{};
    std::unique_ptr<ModuleContext> context(new ModuleContext{env});
    napi_value bootReader = nullptr;
    checked(napi_create_function(env, "readBootSessionId", NAPI_AUTO_LENGTH, readBootSessionId, nullptr, &bootReader));
    property(env, exports, "readBootSessionId", bootReader);
    const struct { const char *name; Method method; } methods[] = {
      {"inspectSupport", Method::inspect}, {"begin", Method::begin}, {"requestEnd", Method::requestEnd},
      {"subscribe", Method::subscribe}, {"disposeAfterEnd", Method::dispose},
      {"readApplicationStatus", Method::readApplications}, {"observeApplicationStatus", Method::observeApplications},
      {"isAttemptActive", Method::isActive},
    };
    for (const auto &entry : methods) {
      napi_value function = nullptr;
      checked(napi_create_function(env, entry.name, NAPI_AUTO_LENGTH, method,
        reinterpret_cast<void *>(static_cast<uintptr_t>(entry.method)), &function));
      property(env, exports, entry.name, function);
    }
    checked(napi_add_env_cleanup_hook(env, cleanup, context.get()));
    processContext = context.release();
    return exports;
  } catch (...) { return exception(env, "AAC_MODULE_UNAVAILABLE"); }
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
