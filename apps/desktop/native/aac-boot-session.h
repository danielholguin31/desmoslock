#pragma once
#include <array>
#include <cstddef>

namespace desmoslock::aac {
// The production calls are public IOKit/CF operations. The pure driver substitutes
// only those calls, so every early return exercises the same ownership boundary.
template <typename IO>
bool readBootSession(IO &io, std::array<char, 37> &output) {
  auto matching = io.matching();
  if (!matching) return false;
  auto service = io.service(matching); // Consumes matching, including on failure.
  if (!service) return false;
  struct ServiceOwner {
    IO &io;
    decltype(service) value;
    ~ServiceOwner() { io.releaseService(value); }
  } serviceOwner{io, service};
  auto property = io.property(service);
  if (!property) return false;
  struct PropertyOwner {
    IO &io;
    decltype(property) value;
    ~PropertyOwner() { io.releaseProperty(value); }
  } propertyOwner{io, property};
  if (!io.isString(property) || io.length(property) != 36) return false;
  std::array<char, 37> bytes{};
  if (!io.ascii(property, bytes.data(), bytes.size()) || bytes[36] != '\0') return false;
  for (std::size_t i = 0; i < 36; ++i) {
    char &value = bytes[i];
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (value != '-') return false;
    } else {
      if (value >= 'A' && value <= 'F') value = static_cast<char>(value + ('a' - 'A'));
      if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) return false;
    }
  }
  output = bytes;
  return true;
}
} // namespace desmoslock::aac
