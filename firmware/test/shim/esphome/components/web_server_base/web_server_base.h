#pragma once
// Host shim for the async web server surface onair_page.h uses.
//
// Fake enough to drive a request end to end: build one, hand it to Page::handleRequest, and
// read the body back out. That is what makes the POST invariants testable - the CSRF Origin
// check, the `busy` refusal, the skin refusal - rather than only the rendered HTML.

#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "esphome/core/helpers.h"

enum WebRequestMethod { HTTP_GET = 1, HTTP_POST = 2 };

/// The real one is a non-owning view over a char buffer. Comparing it to a string literal is
/// the only thing onair_page.h does with it.
class StringRef {
 public:
  StringRef() = default;
  StringRef(const char *s) : s_(s) {}
  bool operator==(const char *other) const { return this->s_ == other; }
  bool operator!=(const char *other) const { return !(*this == other); }
  std::string str() const { return this->s_; }

 private:
  std::string s_;
};

class AsyncWebParameter {
 public:
  explicit AsyncWebParameter(std::string value) : value_(std::move(value)) {}
  const std::string &value() const { return this->value_; }

 private:
  std::string value_;
};

class AsyncWebServerResponse {
 public:
  AsyncWebServerResponse(int code, std::string type, std::string body)
      : code(code), type(std::move(type)), body(std::move(body)) {}
  void addHeader(const char *name, const char *value) { this->headers[name] = value; }

  int code;
  std::string type;
  std::string body;
  std::map<std::string, std::string> headers;
};

/**
 * A request the test builds by hand.
 *
 * `params` is deliberately a map with a PRESENCE distinction, not a "return empty if
 * missing" lookup: handle_action() refuses a POST that merely CARRIES a field named `busy`,
 * whatever its value, and a shim that could not tell absent from empty would make that
 * invariant untestable.
 */
class AsyncWebServerRequest {
 public:
  static constexpr size_t URL_BUF_SIZE = 513;

  AsyncWebServerRequest(WebRequestMethod method, std::string url) : method_(method), url_(std::move(url)) {}

  void set_param(const std::string &name, const std::string &value) {
    this->params_.emplace(name, AsyncWebParameter(value));
  }
  void set_header(const std::string &name, const std::string &value) { this->headers_[name] = value; }

  AsyncWebParameter *getParam(const char *name) {
    auto it = this->params_.find(name);
    return it == this->params_.end() ? nullptr : &it->second;
  }
  bool hasParam(const char *name) const { return this->params_.count(name) != 0; }

  StringRef url_to(char (&)[URL_BUF_SIZE]) const { return StringRef(this->url_.c_str()); }
  WebRequestMethod method() const { return this->method_; }

  esphome::optional<std::string> get_header(const char *name) const {
    auto it = this->headers_.find(name);
    if (it == this->headers_.end())
      return esphome::optional<std::string>();
    return esphome::optional<std::string>(it->second);
  }

  AsyncWebServerResponse *beginResponse(int code, const char *type, const uint8_t *body, size_t len) {
    this->sent_progmem = true;
    return new AsyncWebServerResponse(code, type, std::string((const char *) body, len));
  }

  void send(AsyncWebServerResponse *response) {
    this->status = response->code;
    this->content_type = response->type;
    this->body = response->body;
    this->headers = response->headers;
    delete response;
  }

  void send(int code, const char *type, const char *body) {
    this->status = code;
    this->content_type = type;
    this->body = body;
  }

  // What the handler produced. Read by the tests.
  int status{0};
  std::string content_type;
  std::string body;
  std::map<std::string, std::string> headers;
  bool sent_progmem{false};

 private:
  WebRequestMethod method_;
  std::string url_;
  std::map<std::string, AsyncWebParameter> params_;
  std::map<std::string, std::string> headers_;
};

class AsyncWebHandler {
 public:
  virtual ~AsyncWebHandler() = default;
  virtual bool canHandle(AsyncWebServerRequest *request) const = 0;
  virtual void handleRequest(AsyncWebServerRequest *request) = 0;
};

namespace esphome {
namespace web_server_base {

/// Records which handlers were registered with auth and which without. That distinction is
/// load-bearing (D-57, D-69): /onair and its assets must be reachable with no credential, and
/// a stylesheet behind auth would make the open page prompt for its own subresource.
class WebServerBase {
 public:
  void add_handler(AsyncWebHandler *handler) { this->with_auth.push_back(handler); }
  void add_handler_without_auth(AsyncWebHandler *handler) { this->without_auth.push_back(handler); }

  std::vector<AsyncWebHandler *> with_auth;
  std::vector<AsyncWebHandler *> without_auth;
};

extern WebServerBase *global_web_server_base;

}  // namespace web_server_base
}  // namespace esphome
