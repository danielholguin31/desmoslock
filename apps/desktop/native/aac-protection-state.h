#pragma once
#include <cmath>
#include <cstdint>
#include <string_view>

namespace desmoslock::aac {
constexpr uint64_t maximumSequence = 9007199254740991ULL;
enum class Phase { idle, engaging, active, ending, uncertain, failed, ended };
enum class Event { none, didBegin, failedToBegin, interrupted, didEnd };
struct Effects {
  bool hide = false;
  bool end = false;
  bool armWatchdog = false;
  bool stopWatchdog = false;
  Event event = Event::none;
  uint64_t sequence = 0;
};

inline bool canonicalAttempt(std::string_view value) {
  if (value.size() != 36) return false;
  for (size_t i = 0; i < value.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (value[i] != '-') return false;
    } else if (!((value[i] >= '0' && value[i] <= '9') ||
                 (value[i] >= 'a' && value[i] <= 'f'))) return false;
  }
  return value[14] == '4' && (value[19] == '8' || value[19] == '9' ||
                            value[19] == 'a' || value[19] == 'b');
}
inline bool canonicalSequence(double value) {
  return std::isfinite(value) && value >= 1 && value <= static_cast<double>(maximumSequence) &&
         std::floor(value) == value;
}

// This core never calls AAC. Only observed delegate inputs can produce AAC events.
class Lifecycle {
 public:
  Phase phase = Phase::idle;
  uint64_t sequence = 0;
  bool cancelled = false;
  bool observedBegin = false;
  bool endRequested = false;
  bool exhausted = false;

  bool canDispose() const { return phase == Phase::idle || phase == Phase::failed || phase == Phase::ended; }
  bool activeAt(uint64_t value) const {
    return value > 0 && value <= maximumSequence && value == sequence && !exhausted &&
           phase == Phase::active && observedBegin && !cancelled;
  }
  bool deliver(Event event, uint64_t value) const {
    return event != Event::didBegin || activeAt(value);
  }
  Effects start() {
    if (phase != Phase::idle) return {};
    phase = Phase::engaging;
    Effects effects;
    effects.armWatchdog = true;
    stamp(effects);
    return effects;
  }
  Effects preparationFailed() {
    if ((phase != Phase::engaging && phase != Phase::uncertain) || observedBegin) return fault();
    phase = Phase::failed;
    cancelled = true;
    Effects effects;
    effects.hide = true;
    effects.stopWatchdog = true;
    stamp(effects);
    return effects;
  }
  Effects requestEnd() {
    if (canDispose() || cancelled) return {};
    return invalidate(false);
  }
  Effects fault() {
    if (phase == Phase::idle) return {};
    if (phase == Phase::failed || phase == Phase::ended) {
      Effects effects;
      effects.hide = true;
      return effects;
    }
    return invalidate(true);
  }
  Effects timeout() { return fault(); }
  Effects didBegin() {
    if (phase == Phase::active && !cancelled) return {}; // Duplicate observation.
    if (phase == Phase::ending || (phase == Phase::uncertain && observedBegin)) return {};
    if (phase == Phase::ended) endRequested = false; // A contradictory late begin still needs a new end.
    observedBegin = true;
    if (phase != Phase::engaging || cancelled || exhausted) {
      cancelled = true;
      phase = Phase::ending;
      Effects effects;
      effects.hide = true;
      requestNativeEnd(effects);
      stamp(effects);
      return effects;
    }
    phase = Phase::active;
    Effects effects;
    effects.stopWatchdog = true;
    effects.event = Event::didBegin;
    stamp(effects);
    if (exhausted) {
      effects.event = Event::none;
      effects.hide = true;
      requestNativeEnd(effects);
    }
    return effects;
  }
  Effects failedToBegin() {
    if (phase == Phase::failed) return {};
    if (observedBegin || (phase != Phase::engaging && phase != Phase::uncertain)) return fault();
    cancelled = true;
    phase = Phase::failed;
    Effects effects;
    effects.hide = true;
    effects.stopWatchdog = true;
    effects.event = Event::failedToBegin;
    stamp(effects);
    return effects;
  }
  Effects interrupted() {
    if (canDispose() || interrupted_) return {};
    interrupted_ = true;
    Effects effects = invalidate(!observedBegin);
    if (!exhausted) effects.event = Event::interrupted;
    return effects;
  }
  Effects didEnd() {
    if (phase == Phase::ended) return {};
    if (!observedBegin) return fault(); // Never infer that a pending begin was cancelled.
    cancelled = true;
    phase = Phase::ended;
    Effects effects;
    effects.hide = true;
    effects.stopWatchdog = true;
    effects.event = Event::didEnd;
    stamp(effects);
    return effects;
  }

 private:
  bool interrupted_ = false;
  void stamp(Effects &effects) {
    if (sequence >= maximumSequence) {
      exhausted = true;
      cancelled = true;
      if (!canDispose()) phase = Phase::uncertain;
      effects.hide = true;
      effects.event = Event::none;
    } else ++sequence;
    effects.sequence = sequence;
  }
  void requestNativeEnd(Effects &effects) {
    if (observedBegin && !endRequested) {
      endRequested = true; // Reserve before the native call can synchronously callback.
      effects.end = true;
      effects.armWatchdog = true;
    }
  }
  Effects invalidate(bool uncertain) {
    cancelled = true; // Native usability closes before hiding or any callback delivery.
    phase = uncertain ? Phase::uncertain : (observedBegin ? Phase::ending : Phase::engaging);
    Effects effects;
    effects.hide = true;
    requestNativeEnd(effects);
    stamp(effects);
    return effects;
  }
};

// One ordering seam is used by the real delegate and the non-shipped driver.
template <class Sink> void perform(const Effects &effects, Sink &sink) {
  if (effects.hide) sink.hide();
  if (effects.stopWatchdog) sink.stopWatchdog();
  if (effects.armWatchdog) sink.armWatchdog();
  if (effects.event != Event::none) sink.emit(effects.event, effects.sequence);
  if (effects.end) sink.end(); // A synchronous didEnd must follow the current event in queue order.
}

enum class ApplicationStatus { clear, blocked, unavailable };
enum class Activation { regular, accessory, prohibited, unknown };
struct ApplicationFacts {
  Activation activation;
  bool knownIdentity;
  bool ownApplication;
  bool exactSystemFinder;
};
inline ApplicationStatus classify(const ApplicationFacts &facts) {
  if (!facts.knownIdentity || facts.activation == Activation::unknown) return ApplicationStatus::unavailable;
  if (facts.activation != Activation::regular || facts.ownApplication || facts.exactSystemFinder)
    return ApplicationStatus::clear;
  return ApplicationStatus::blocked;
}
} // namespace desmoslock::aac
