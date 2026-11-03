cmake_minimum_required(VERSION 3.28)
project(CXETCPP_Sample LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Find dependencies
find_package(Threads REQUIRED)

# Library target with template/inline implementations
add_library(sample_core STATIC
    src/sample_core.cpp
)

target_include_directories(sample_core
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
)

target_link_libraries(sample_core
    PUBLIC
        Threads::Threads
)

# Executable target
add_executable(sample_runner
    src/main.cpp
)

target_link_libraries(sample_runner
    PRIVATE
        sample_core
)

# Installation rules
install(TARGETS sample_core sample_runner
    EXPORT SampleTargets
    ARCHIVE DESTINATION lib
    LIBRARY DESTINATION lib
    RUNTIME DESTINATION bin
)
