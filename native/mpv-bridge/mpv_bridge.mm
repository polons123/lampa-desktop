// Embeds libmpv into an NSOpenGLView placed *behind* Electron's web view
// (mpv render API; mpv's `wid` option is ignored on macOS).
#import <AppKit/AppKit.h>
#include <napi.h>
#include <mpv/client.h>
#include <mpv/render_gl.h>
#include <OpenGL/gl3.h>
#include <atomic>
#include <string>
#include <vector>

static mpv_handle *g_mpv = nullptr;
static NSView *g_video = nil;
static mpv_render_context *g_render = nullptr;

static void *GetProcAddress(void *, const char *name) {
  static CFBundleRef gl = CFBundleGetBundleWithIdentifier(CFSTR("com.apple.opengl"));
  CFStringRef n = CFStringCreateWithCString(kCFAllocatorDefault, name, kCFStringEncodingASCII);
  void *p = CFBundleGetFunctionPointerForName(gl, n);
  CFRelease(n);
  return p;
}

@interface MpvGLView : NSOpenGLView
@end
@implementation MpvGLView
- (instancetype)initWithFrame:(NSRect)f {
  NSOpenGLPixelFormatAttribute attrs[] = {
      NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion3_2Core,
      NSOpenGLPFADoubleBuffer, NSOpenGLPFAAccelerated, 0};
  NSOpenGLPixelFormat *pf = [[NSOpenGLPixelFormat alloc] initWithAttributes:attrs];
  self = [super initWithFrame:f pixelFormat:pf];
  if (self) {
    self.wantsBestResolutionOpenGLSurface = YES;
    GLint swap = 1;
    [self.openGLContext setValues:&swap forParameter:NSOpenGLContextParameterSwapInterval];
  }
  return self;
}
- (void)drawRect:(NSRect)dirty {
  [self.openGLContext makeCurrentContext];
  if (g_render) {
    NSRect b = [self convertRectToBacking:self.bounds];
    mpv_opengl_fbo fbo = {0, (int)b.size.width, (int)b.size.height, 0};
    int flip = 1;
    mpv_render_param params[] = {{MPV_RENDER_PARAM_OPENGL_FBO, &fbo},
                                 {MPV_RENDER_PARAM_FLIP_Y, &flip},
                                 {MPV_RENDER_PARAM_INVALID, nullptr}};
    mpv_render_context_render(g_render, params);
  } else {
    glClearColor(0, 0, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
  }
  [self.openGLContext flushBuffer];
}
@end

static void OnRenderUpdate(void *ctx) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (g_video && g_render &&
        (mpv_render_context_update(g_render) & MPV_RENDER_UPDATE_FRAME))
      [g_video setNeedsDisplay:YES];
  });
}

static Napi::Value Fail(Napi::Env env, const std::string &msg) {
  Napi::Error::New(env, msg).ThrowAsJavaScriptException();
  return env.Undefined();
}

static Napi::ThreadSafeFunction g_tsfn;
static std::atomic<bool> g_tsfn_alive{false};
static std::atomic<bool> g_drain_pending{false};


static Napi::Value NodeToJs(Napi::Env env, const mpv_node *n) {
  switch (n->format) {
    case MPV_FORMAT_STRING: return Napi::String::New(env, n->u.string);
    case MPV_FORMAT_FLAG: return Napi::Boolean::New(env, n->u.flag != 0);
    case MPV_FORMAT_INT64: return Napi::Number::New(env, (double)n->u.int64);
    case MPV_FORMAT_DOUBLE: return Napi::Number::New(env, n->u.double_);
    case MPV_FORMAT_NODE_ARRAY: {
      Napi::Array a = Napi::Array::New(env, n->u.list->num);
      for (int i = 0; i < n->u.list->num; i++) a.Set((uint32_t)i, NodeToJs(env, &n->u.list->values[i]));
      return a;
    }
    case MPV_FORMAT_NODE_MAP: {
      Napi::Object o = Napi::Object::New(env);
      for (int i = 0; i < n->u.list->num; i++) o.Set(n->u.list->keys[i], NodeToJs(env, &n->u.list->values[i]));
      return o;
    }
    default: return env.Null();
  }
}

// Runs on the JS thread: drains all pending mpv events into the JS callback.
static void DrainEvents(Napi::Env env, Napi::Function cb) {
  g_drain_pending = false;
  while (g_mpv) {
    mpv_event *ev = mpv_wait_event(g_mpv, 0);
    if (ev->event_id == MPV_EVENT_NONE) break;
    Napi::Object o = Napi::Object::New(env);
    o.Set("event", mpv_event_name(ev->event_id));
    if (ev->event_id == MPV_EVENT_PROPERTY_CHANGE) {
      mpv_event_property *p = (mpv_event_property *)ev->data;
      o.Set("name", p->name);
      if (p->format == MPV_FORMAT_NODE) o.Set("data", NodeToJs(env, (mpv_node *)p->data));
      else o.Set("data", env.Null());
    } else if (ev->event_id == MPV_EVENT_END_FILE) {
      mpv_event_end_file *e = (mpv_event_end_file *)ev->data;
      // 0 eof, 2 stop, 3 quit, 4 error, 5 redirect
      o.Set("reason", (double)e->reason);
      if (e->error < 0) o.Set("error", mpv_error_string(e->error));
    } else if (ev->event_id == MPV_EVENT_LOG_MESSAGE) {
      mpv_event_log_message *m = (mpv_event_log_message *)ev->data;
      o.Set("prefix", m->prefix);
      o.Set("level", m->level);
      o.Set("text", m->text);
    } else if (ev->event_id == MPV_EVENT_SHUTDOWN) {
      cb.Call({o});
      break;
    }
    cb.Call({o});
  }
}

static void OnWakeup(void *) {
  if (!g_tsfn_alive || g_drain_pending.exchange(true)) return;
  if (g_tsfn.BlockingCall(DrainEvents) != napi_ok) g_drain_pending = false;
}

// attach(nativeWindowHandle: Buffer, onEvent: (ev) => void)
Napi::Value Attach(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (g_mpv) return Fail(env, "already attached");
  if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsFunction())
    return Fail(env, "attach(handle: Buffer, onEvent: Function)");
  NSView *content = *reinterpret_cast<NSView **>(info[0].As<Napi::Buffer<uint8_t>>().Data());
  if (!content) return Fail(env, "null NSView");

  g_video = [[MpvGLView alloc] initWithFrame:content.bounds];
  g_video.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  // Below every existing subview (i.e. below the web view).
  [content addSubview:g_video positioned:NSWindowBelow relativeTo:nil];

  g_mpv = mpv_create();
  if (!g_mpv) return Fail(env, "mpv_create failed");
  mpv_set_option_string(g_mpv, "vo", "libmpv");
  mpv_set_option_string(g_mpv, "hwdec", "videotoolbox");
  mpv_set_option_string(g_mpv, "input-default-bindings", "no");
  mpv_set_option_string(g_mpv, "input-vo-keyboard", "no");
  mpv_set_option_string(g_mpv, "osc", "no");
  mpv_set_option_string(g_mpv, "config", "no");
  mpv_set_option_string(g_mpv, "keep-open", "yes");
  mpv_set_option_string(g_mpv, "idle", "yes");
  int rc = mpv_initialize(g_mpv);
  if (rc < 0) return Fail(env, std::string("mpv_initialize: ") + mpv_error_string(rc));

  [((NSOpenGLView *)g_video).openGLContext makeCurrentContext];
  mpv_opengl_init_params glInit = {GetProcAddress, nullptr};
  const char *api = MPV_RENDER_API_TYPE_OPENGL;
  mpv_render_param rp[] = {{MPV_RENDER_PARAM_API_TYPE, (void *)api},
                           {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &glInit},
                           {MPV_RENDER_PARAM_INVALID, nullptr}};
  rc = mpv_render_context_create(&g_render, g_mpv, rp);
  if (rc < 0) return Fail(env, std::string("render_context_create: ") + mpv_error_string(rc));
  mpv_render_context_set_update_callback(g_render, OnRenderUpdate, nullptr);

  g_tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "mpv-events", 0, 1);
  g_tsfn_alive = true;
  mpv_request_log_messages(g_mpv, "warn");
  mpv_set_wakeup_callback(g_mpv, OnWakeup, nullptr);
  return env.Undefined();
}

// observe(name: string, id: number) — property changes arrive as events.
Napi::Value Observe(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!g_mpv) return Fail(env, "not attached");
  int rc = mpv_observe_property(g_mpv, (uint64_t)info[1].ToNumber().Int64Value(),
                                info[0].ToString().Utf8Value().c_str(), MPV_FORMAT_NODE);
  return Napi::Number::New(env, rc);
}

// command(["loadfile", url]) etc.
Napi::Value Command(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!g_mpv) return Fail(env, "not attached");
  if (info.Length() < 1 || !info[0].IsArray()) return Fail(env, "need array");
  Napi::Array arr = info[0].As<Napi::Array>();
  std::vector<std::string> store;
  for (uint32_t i = 0; i < arr.Length(); i++) store.push_back(arr.Get(i).ToString().Utf8Value());
  std::vector<const char *> argv;
  for (auto &s : store) argv.push_back(s.c_str());
  argv.push_back(nullptr);
  int rc = mpv_command(g_mpv, argv.data());
  return Napi::Number::New(env, rc);
}

Napi::Value GetProperty(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!g_mpv) return Fail(env, "not attached");
  char *s = mpv_get_property_string(g_mpv, info[0].ToString().Utf8Value().c_str());
  if (!s) return env.Null();
  Napi::String r = Napi::String::New(env, s);
  mpv_free(s);
  return r;
}

Napi::Value SetProperty(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!g_mpv) return Fail(env, "not attached");
  int rc = mpv_set_property_string(g_mpv, info[0].ToString().Utf8Value().c_str(),
                                   info[1].ToString().Utf8Value().c_str());
  return Napi::Number::New(env, rc);
}

Napi::Value SetHidden(const Napi::CallbackInfo &info) {
  if (g_video) g_video.hidden = info[0].ToBoolean().Value();
  return info.Env().Undefined();
}

Napi::Value Destroy(const Napi::CallbackInfo &info) {
  g_tsfn_alive = false;
  if (g_mpv) mpv_set_wakeup_callback(g_mpv, nullptr, nullptr);
  if (g_render) { mpv_render_context_free(g_render); g_render = nullptr; }
  if (g_mpv) { mpv_terminate_destroy(g_mpv); g_mpv = nullptr; }
  if (g_video) { [g_video removeFromSuperview]; g_video = nil; }
  if (g_tsfn) { g_tsfn.Release(); g_tsfn = Napi::ThreadSafeFunction(); }
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("attach", Napi::Function::New(env, Attach));
  exports.Set("observe", Napi::Function::New(env, Observe));
  exports.Set("command", Napi::Function::New(env, Command));
  exports.Set("getProperty", Napi::Function::New(env, GetProperty));
  exports.Set("setProperty", Napi::Function::New(env, SetProperty));
  exports.Set("setHidden", Napi::Function::New(env, SetHidden));
  exports.Set("destroy", Napi::Function::New(env, Destroy));
  return exports;
}
NODE_API_MODULE(mpv_bridge, Init)
