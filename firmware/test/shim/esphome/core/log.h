#pragma once
// Host shim. Logs go to stderr so a test run shows what the firmware would have said,
// without polluting stdout, which carries the test results.
#include <cstdio>

#define ESP_LOGD(tag, ...) do { fprintf(stderr, "[D][%s] ", tag); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } while (0)
#define ESP_LOGI(tag, ...) do { fprintf(stderr, "[I][%s] ", tag); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } while (0)
#define ESP_LOGW(tag, ...) do { fprintf(stderr, "[W][%s] ", tag); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } while (0)
#define ESP_LOGE(tag, ...) do { fprintf(stderr, "[E][%s] ", tag); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } while (0)
