# C/C++ & CMake Kit

Modern C/C++ development companion for Orca, adding rich syntax highlighting for C++ inline and template definitions, C++20 modules, plus full CMake language support.

## Features

### 1. C++ Inline & Template Definitions (`.ipp`, `.inl`, `.tpp`, `.tcc`, `.ixx`, `.cppm`)
- Syntax highlighting for separated C++ template implementations, inline headers, and C++20 module interface units.
- Full support for C++20/23 keywords: `concept`, `requires`, `consteval`, `constexpr`, `co_await`, `co_yield`, `co_return`, `decltype`, `noexcept`.
- Operator overload definitions (`operator[]`, `operator+`, `operator<<`, etc.).
- Nested template angle brackets `<...>`, type parameters (`typename`, `class`), and variable templates.
- Standard namespace symbols (`std::`, `chrono`, `filesystem`, `views`, `ranges`, type traits).

### 2. CMake Build System (`CMakeLists.txt`, `*.cmake`, `CMakeCache.txt`)
- Built-in commands (`project`, `add_executable`, `add_library`, `target_link_libraries`, `find_package`, `FetchContent_*`).
- Control flow structures (`if`, `elseif`, `else`, `endif`, `foreach`, `while`, `function`, `macro`).
- Variable expansions (`${VAR}`, `$ENV{VAR}`, `$CACHE{VAR}`) and generator expressions (`$<...>`).
- Standard targets, scopes (`PUBLIC`, `PRIVATE`, `INTERFACE`), and bracket comments (`#[[ ... ]]`).

## License

MIT
