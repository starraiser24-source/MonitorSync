cmake_minimum_required(VERSION 3.5.0)
project(streamer)

set(NATIVERENDER_ROOT_PATH ${CMAKE_CURRENT_SOURCE_DIR})
include_directories(${NATIVERENDER_ROOT_PATH})

add_library(streamer SHARED screen_streamer.cpp)
target_link_libraries(streamer PUBLIC
    libace_napi.z.so
    libhilog_ndk.z.so
    libnative_avscreen_capture.so
    libnative_media_venc.so
    libnative_media_core.so
    libnative_media_codecbase.so
    libnative_window.so
)
