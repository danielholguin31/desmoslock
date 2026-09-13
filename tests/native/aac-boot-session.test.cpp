#include "../../apps/desktop/native/aac-boot-session.h"
#include <cassert>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>

using desmoslock::aac::readBootSession;
struct FakeIO {
  bool hasMatching = true, hasService = true, hasProperty = true, stringType = true;
  bool conversion = true, terminator = true, conversionThrows = false;
  int stringLength = 36;
  int matchingCreated = 0, matchingConsumed = 0, serviceCreated = 0, serviceReleased = 0;
  int propertyCreated = 0, propertyReleased = 0, conversions = 0;
  std::string value = "abcdef01-2345-0123-4567-89abcdef0123";
  int matching() { matchingCreated += hasMatching; return hasMatching ? 1 : 0; }
  int service(int value) {
    assert(value == 1); ++matchingConsumed;
    serviceCreated += hasService; return hasService ? 2 : 0;
  }
  int property(int value) {
    assert(value == 2); propertyCreated += hasProperty; return hasProperty ? 3 : 0;
  }
  bool isString(int value) { assert(value == 3); return stringType; }
  int length(int value) { assert(value == 3 && stringType); return stringLength; }
  bool ascii(int property, char *output, std::size_t capacity) {
    assert(property == 3 && stringType && stringLength == 36 && capacity == 37);
    ++conversions;
    if (conversionThrows) throw std::runtime_error("synthetic conversion exception");
    if (!conversion) return false;
    assert(value.size() == 36);
    std::memcpy(output, value.data(), 36);
    output[36] = terminator ? '\0' : 'x';
    return true;
  }
  void releaseService(int value) { assert(value == 2); ++serviceReleased; }
  void releaseProperty(int value) { assert(value == 3); ++propertyReleased; }
  void balanced() const {
    assert(matchingCreated == matchingConsumed);
    assert(serviceCreated == serviceReleased && propertyCreated == propertyReleased);
  }
};
int passed = 0;
void pass(const char *name) {
  ++passed; std::cout << "{\"case\":\"" << name << "\",\"passed\":true}\n";
}
void rejects(const char *name, FakeIO io) {
  std::array<char, 37> output; output.fill('!');
  const auto before = output;
  assert(!readBootSession(io, output)); assert(output == before); io.balanced(); pass(name);
}
int main() {
  for (const auto &entry : {
      std::pair{"lowercase", "abcdef01-2345-0123-4567-89abcdef0123"},
      std::pair{"uppercase", "ABCDEF01-2345-0123-4567-89ABCDEF0123"},
      std::pair{"no_version_or_variant_constraint", "00000000-0000-0000-0000-000000000000"}}) {
    FakeIO io; io.value = entry.second; std::array<char, 37> output{};
    assert(readBootSession(io, output)); io.balanced();
    assert(std::strlen(output.data()) == 36);
    for (char byte : output) assert(!(byte >= 'A' && byte <= 'F'));
    if (std::string(entry.first) != "no_version_or_variant_constraint")
      assert(std::string(output.data()) == "abcdef01-2345-0123-4567-89abcdef0123");
    pass(entry.first);
  }
  { FakeIO io; io.hasMatching = false; rejects("missing_matching", io); }
  { FakeIO io; io.hasService = false; rejects("missing_service_consumes_matching", io); }
  { FakeIO io; io.hasProperty = false; rejects("missing_property_releases_service", io); }
  { FakeIO io; io.stringType = false; rejects("wrong_CF_type", io); }
  { FakeIO io; io.stringLength = 0; rejects("empty_CF_string", io); }
  { FakeIO io; io.stringLength = 35; rejects("short_CF_string", io); }
  { FakeIO io; io.stringLength = 37; rejects("overlong_CF_string", io); }
  { FakeIO io; io.conversion = false; rejects("lossless_ASCII_conversion_failure", io); }
  { FakeIO io; io.terminator = false; rejects("missing_terminator", io); }
  { FakeIO io; io.value[0] = static_cast<char>(0xff); rejects("non_ASCII", io); }
  { FakeIO io; io.value[0] = '\0'; rejects("embedded_null", io); }
  { FakeIO io; io.value[0] = 'g'; rejects("nonhex", io); }
  { FakeIO io; io.value[8] = '0'; rejects("missing_hyphen", io); }
  { FakeIO io; io.value[7] = '-'; rejects("misplaced_hyphen", io); }
  {
    FakeIO io; io.conversionThrows = true; std::array<char, 37> output{};
    bool threw = false;
    try { (void)readBootSession(io, output); } catch (const std::runtime_error &) { threw = true; }
    assert(threw); io.balanced(); pass("exception_unwinds_both_owners");
  }
  assert(passed == 18);
  std::cout << "{\"passed\":" << passed << ",\"frameworkCalls\":0}\n";
}
