{
  "targets": [{
    "target_name": "mpv_bridge",
    "sources": ["mpv_bridge.mm"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")", "/opt/homebrew/include"],
    "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
    "libraries": ["-L/opt/homebrew/lib", "-lmpv", "-Wl,-rpath,/opt/homebrew/lib"],
    "xcode_settings": {
      "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
      "MACOSX_DEPLOYMENT_TARGET": "13.0",
      "OTHER_LDFLAGS": ["-framework", "AppKit", "-framework", "QuartzCore", "-framework", "OpenGL"],
      "GCC_ENABLE_CPP_EXCEPTIONS": "NO"
    }
  }]
}
