#include "../../apps/desktop/native/aac-protection-state.h"
#include <cstdlib>
#include <iostream>
#include <limits>
#include <string>
#include <utility>
#include <vector>

using namespace desmoslock::aac;

static void require(bool condition, const char *message) {
  if (!condition) {
    std::cerr << "Lifecycle assertion failed: " << message << '\n';
    std::exit(1);
  }
}

// This non-shipped driver performs no Objective-C, AppKit or AAC calls. Its
// synthetic effects exercise the same ordering core used by the real delegate.
struct Driver {
  Lifecycle state;
  std::vector<std::string> effects;
  std::vector<std::pair<Event, uint64_t>> events;
  unsigned ends = 0;
  bool synchronousEnd = false;
  bool failDelivery = false;
  bool watchdog = false;
  void apply(Effects value) { perform(value, *this); }
  void hide() { effects.emplace_back("hide"); }
  void stopWatchdog() { watchdog = false; effects.emplace_back("stop"); }
  void armWatchdog() { watchdog = true; effects.emplace_back("arm"); }
  void emit(Event event, uint64_t sequence) {
    effects.emplace_back("emit");
    events.emplace_back(event, sequence);
    if (failDelivery) apply(state.fault());
  }
  void end() {
    ++ends;
    effects.emplace_back("end");
    require(state.cancelled && state.endRequested, "end ownership reserved before call");
    if (synchronousEnd) apply(state.didEnd());
  }
  void begin() { apply(state.start()); }
  uint64_t becomeActive() {
    begin();
    apply(state.didBegin());
    return state.sequence;
  }
};

static unsigned passed = 0;
template <class Body> static void check(const char *name, Body body) {
  body();
  ++passed;
  std::cout << "{\"case\":\"" << name << "\",\"passed\":true}\n";
}

int main() {
  check("canonical-attempt-and-sequence", [] {
    require(canonicalAttempt("12345678-1234-4abc-8abc-123456789abc"), "canonical UUIDv4 accepted");
    for (const auto *value : {"", "12345678-1234-4ABC-8abc-123456789abc",
         "12345678-1234-1abc-8abc-123456789abc", "12345678-1234-4abc-cabc-123456789abc",
         "12345678-1234-4abc-8abc-123456789abcx"})
      require(!canonicalAttempt(value), "noncanonical attempt rejected");
    require(canonicalSequence(1) && canonicalSequence(static_cast<double>(maximumSequence)), "safe sequence accepted");
    for (double value : {0., -1., 1.5, static_cast<double>(maximumSequence) + 1.,
         std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()})
      require(!canonicalSequence(value), "noncanonical sequence rejected");
  });
  check("pending-cancellation-retains-until-observed-end", [] {
    Driver d;
    d.begin();
    d.apply(d.state.requestEnd());
    require(!d.state.canDispose() && d.ends == 0 && d.watchdog, "pending cancel retains without premature end");
    require(d.events.empty(), "pending cancellation fabricates no delegate event");
    d.apply(d.state.didBegin());
    require(d.ends == 1 && d.events.empty(), "late begin hides and ends without positive callback");
    require(!d.state.canDispose() && !d.state.activeAt(d.state.sequence), "late begin is never usable");
    d.apply(d.state.didEnd());
    require(d.state.canDispose() && !d.watchdog, "observed end permits cleanup");
    require(d.events.size() == 1 && d.events[0].first == Event::didEnd, "only actual end is delivered");
  });
  check("cancelled-pending-failure-cleans-without-invented-end", [] {
    Driver d;
    d.begin();
    d.apply(d.state.requestEnd());
    d.apply(d.state.failedToBegin());
    require(d.state.canDispose() && d.ends == 0 && !d.watchdog, "valid failed-start cleanup");
    require(d.events.size() == 1 && d.events[0].first == Event::failedToBegin, "failure event correlated");
    d.apply(d.state.failedToBegin());
    require(d.events.size() == 1, "duplicate failure coalesced");
  });
  check("active-end-is-hidden-and-single-flight", [] {
    Driver d;
    const auto active = d.becomeActive();
    require(d.state.activeAt(active) && !d.state.canDispose() && !d.watchdog, "genuine begin is usable");
    d.effects.clear();
    d.apply(d.state.requestEnd());
    d.apply(d.state.requestEnd());
    require(d.effects.front() == "hide" && d.ends == 1 && d.watchdog, "hide precedes one native end");
    require(!d.state.activeAt(active) && !d.state.canDispose(), "end request is not end proof");
    d.apply(d.state.didEnd());
    d.apply(d.state.didEnd());
    require(d.state.canDispose() && d.events.size() == 2, "one begin and one observed end");
  });
  check("end-before-begin-retains-uncertain-owner", [] {
    Driver d;
    d.begin();
    d.apply(d.state.didEnd());
    require(!d.state.canDispose() && d.ends == 0 && d.events.empty(), "early end cannot prove cancellation");
    d.apply(d.state.didBegin());
    require(d.ends == 1 && d.events.empty(), "later begin still requires actual cleanup");
  });
  check("watchdog-and-post-invocation-error-never-forge-failure", [] {
    for (bool timeout : {false, true}) {
      Driver d;
      d.begin();
      d.apply(timeout ? d.state.timeout() : d.state.fault());
      require(!d.state.canDispose() && d.events.empty(), "unknown native outcome remains retained");
      d.apply(d.state.didBegin());
      require(d.ends == 1 && d.events.empty(), "late active observation is cancelled");
    }
    Driver preparation;
    preparation.begin();
    preparation.apply(preparation.state.preparationFailed());
    require(preparation.state.canDispose() && preparation.events.empty() && preparation.ends == 0,
            "pre-invocation preparation failure alone permits local cleanup");
  });
  check("interruption-order-survives-synchronous-end-callback", [] {
    Driver d;
    d.becomeActive();
    d.effects.clear();
    d.synchronousEnd = true;
    d.apply(d.state.interrupted());
    require(d.effects.front() == "hide" && d.ends == 1, "interruption hides before end");
    require(d.events.size() == 3 && d.events[1].first == Event::interrupted && d.events[2].first == Event::didEnd,
            "interruption is enqueued before reentrant didEnd");
    require(d.events[1].second < d.events[2].second && d.state.canDispose(), "strict sequence order through end");
  });
  check("queued-positive-callback-is-fenced-after-invalidation", [] {
    Driver d;
    const auto queued = d.becomeActive();
    require(d.state.deliver(Event::didBegin, queued), "current queued positive event is valid");
    d.apply(d.state.interrupted());
    require(!d.state.deliver(Event::didBegin, queued), "queued begin cannot outlive native invalidation");
    d.apply(d.state.didEnd());
    require(!d.state.deliver(Event::didBegin, queued), "observed end does not revive a queued begin");
  });
  check("post-await-pre-attach-query-prevents-stale-promotion", [] {
    Driver d;
    const auto delivered = d.becomeActive();
    require(d.state.activeAt(delivered), "listener sees a current active event");
    // A storage/backend await yields; native ownership invalidates before its
    // continuation resumes. All other categories deliberately remain true.
    const bool otherFourCategories = true, backendCurrent = true, storageCommitted = true;
    d.apply(d.state.requestEnd());
    const bool attach = otherFourCategories && backendCurrent && storageCommitted && d.state.activeAt(delivered);
    require(!attach, "final synchronous native query blocks stale attachment");
    require(!d.state.activeAt(delivered + 1), "caller cannot supply a replacement sequence as proof");
  });
  check("callback-failure-closes-native-eligibility-without-another-event", [] {
    Driver d;
    d.failDelivery = true;
    d.becomeActive();
    require(!d.state.activeAt(d.state.sequence) && !d.state.canDispose() && d.ends == 1,
            "delivery fault hides and requests end without JS cooperation");
    require(d.events.size() == 1, "fault fabricates no AAC callback");
  });
  check("sequence-exhaustion-never-reuses-positive-or-interruption-proof", [] {
    Driver d;
    d.begin();
    d.state.sequence = maximumSequence;
    d.apply(d.state.didBegin());
    require(d.state.exhausted && d.events.empty() && d.ends == 1 && !d.state.activeAt(maximumSequence),
            "exhausted begin remains unusable and requests cleanup");
    d.apply(d.state.interrupted());
    require(d.events.empty(), "exhausted interruption does not reuse sequence");
    d.apply(d.state.didEnd());
    require(d.state.canDispose() && d.events.empty(), "actual cleanup can finish without a forged sequence");
  });
  check("duplicates-and-contradictory-late-begin-do-not-release-ownership", [] {
    Driver d;
    const auto active = d.becomeActive();
    d.apply(d.state.didBegin());
    require(d.events.size() == 1 && d.state.activeAt(active), "duplicate begin is inert");
    d.apply(d.state.failedToBegin());
    require(!d.state.canDispose() && d.ends == 1, "contradictory failure cannot discard active session");
    d.apply(d.state.didEnd());
    d.apply(d.state.didBegin());
    require(d.ends == 2 && !d.state.canDispose(), "late begin after observed end reclaims uncertain native ownership");
  });
  check("fixed-regular-application-policy-fails-closed", [] {
    require(classify({Activation::regular, true, true, false}) == ApplicationStatus::clear, "exact own app allowed");
    require(classify({Activation::regular, true, false, true}) == ApplicationStatus::clear, "exact system Finder allowed");
    require(classify({Activation::regular, true, false, false}) == ApplicationStatus::blocked, "other regular app prohibited");
    require(classify({Activation::accessory, true, false, false}) == ApplicationStatus::clear, "known accessory matches selected policy");
    require(classify({Activation::prohibited, true, false, false}) == ApplicationStatus::clear, "known prohibited activation is not a regular app");
    require(classify({Activation::unknown, true, true, true}) == ApplicationStatus::unavailable, "unknown classification never excused");
    require(classify({Activation::regular, false, true, true}) == ApplicationStatus::unavailable, "missing identity never excused");
    require(classify({Activation::accessory, false, false, false}) == ApplicationStatus::unavailable, "accessory identity still required");
  });
  std::cout << "{\"passed\":" << passed << ",\"frameworkCalls\":0}\n";
}
