#pragma once
// Host shim. The device blocks the httpd task here; see task.h for what happens instead.
#define pdMS_TO_TICKS(ms) (ms)
