#pragma once
// Host shim: an in-memory NVS.
//
// Real enough to test the thing that matters about the device's persistence, which is not
// "does a write land" but the READ-BACK CONTRACT: save() only QUEUES on the device and the
// blob write happens in sync(), which is why save_overlay() and save_appearance() verify by
// loading again. That two-step is reproduced here, so a test can make sync() fail and prove
// the verify catches it.
#include <cstdint>
#include <cstring>
#include <map>
#include <vector>

namespace esphome {

struct PrefStore {
  std::map<uint32_t, std::vector<uint8_t>> committed;
  std::map<uint32_t, std::vector<uint8_t>> pending;
  /// Set by a test to simulate the failure Espressif warn about: a blob write that fails on
  /// page fragmentation with space apparently free.
  bool fail_sync{false};
  void reset() {
    this->committed.clear();
    this->pending.clear();
    this->fail_sync = false;
  }
};

extern PrefStore g_prefs;

class ESPPreferenceObject {
 public:
  ESPPreferenceObject() = default;
  explicit ESPPreferenceObject(uint32_t key, size_t len) : key_(key), len_(len) {}

  template<typename T> bool save(const T *src) {
    std::vector<uint8_t> bytes(sizeof(T));
    memcpy(bytes.data(), src, sizeof(T));
    g_prefs.pending[this->key_] = bytes;   // QUEUED, not written. sync() commits.
    return true;
  }

  template<typename T> bool load(T *dest) {
    auto it = g_prefs.committed.find(this->key_);
    if (it == g_prefs.committed.end() || it->second.size() != sizeof(T))
      return false;
    memcpy(dest, it->second.data(), sizeof(T));
    return true;
  }

 protected:
  uint32_t key_{0};
  size_t len_{0};
};

class ESPPreferences {
 public:
  template<typename T> ESPPreferenceObject make_preference(uint32_t key) {
    return ESPPreferenceObject(key, sizeof(T));
  }
  bool sync() {
    if (g_prefs.fail_sync)
      return false;
    for (auto &entry : g_prefs.pending)
      g_prefs.committed[entry.first] = entry.second;
    g_prefs.pending.clear();
    return true;
  }
};

extern ESPPreferences *global_preferences;

}  // namespace esphome
