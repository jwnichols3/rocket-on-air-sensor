#pragma once
// Host shim for the on-air HTML tests. See firmware/test/README.md.
//
// This is NOT a reimplementation of ESPHome. It is the smallest set of symbols that lets
// onair_table.h and onair_page.h COMPILE AND RUN on a laptop, so the HTML they generate can
// be asserted on. Anything the tests do not exercise is present only to satisfy the
// compiler, and is marked as such.

#include <cstdint>

namespace esphome {

/// Controllable clock. The device's millis() is monotonic from boot; here the test drives it,
/// because staleness - and therefore THE BUSY RULE - is a function of elapsed time and a test
/// that cannot move the clock cannot reach the branch that matters most.
extern uint32_t g_millis;
inline uint32_t millis() { return g_millis; }

/// Single-threaded here, so these are no-ops. The device's real contention is between the
/// esp-idf httpd task and the main loop; a host test has neither, and pretending otherwise
/// would be theatre. What IS tested is that the page builders take the lock at all - a
/// deadlock would hang this binary, which is a real signal.
class Mutex {
 public:
  void lock() {}
  void unlock() {}
  bool try_lock() { return true; }
};

class LockGuard {
 public:
  explicit LockGuard(Mutex &mutex) : mutex_(mutex) { this->mutex_.lock(); }
  ~LockGuard() { this->mutex_.unlock(); }

 private:
  Mutex &mutex_;
};

}  // namespace esphome
