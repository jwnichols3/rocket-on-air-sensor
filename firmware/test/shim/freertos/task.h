#pragma once
// Host shim for vTaskDelay.
//
// THIS IS THE INTERESTING ONE. On the device, submit() stages a command and then blocks the
// httpd task in vTaskDelay while the MAIN LOOP picks it up and applies it. Two tasks, and
// the whole three-outcome model (APPLIED / FAILED / PENDING, D-64) exists because that
// handoff can miss its window.
//
// A host test has one thread. If vTaskDelay simply slept, submit() would spin for two
// seconds and always report PENDING, and every test would be asserting on a timeout rather
// than on real behaviour.
//
// So vTaskDelay runs the main loop instead of sleeping. That makes the handoff real - the
// command is genuinely staged, taken, applied and reported through the same code path the
// device uses - while collapsing the concurrency the host cannot reproduce.
//
// A test can point the hook elsewhere to reproduce the cases that MATTER:
//   - leave it null           -> the loop never runs: PENDING, the D-64 case
//   - a hook that does nothing but count -> proves submit() gives up rather than hanging
// The default is set in test_page.cpp once onair::pump() is visible.

#include <cstdint>

/// Called once per vTaskDelay. Set to onair::pump to make the staging path real.
extern void (*g_task_yield_hook)();

inline void vTaskDelay(uint32_t) {
  if (g_task_yield_hook != nullptr)
    g_task_yield_hook();
}
