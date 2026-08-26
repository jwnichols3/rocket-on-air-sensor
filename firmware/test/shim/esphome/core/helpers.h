#pragma once
// Host shim. `optional` is the only thing onair_page.h needs from here, for get_header().
#include <optional>

namespace esphome {
template<typename T> using optional = std::optional<T>;
}  // namespace esphome
