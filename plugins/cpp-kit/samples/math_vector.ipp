// ============================================================================
// math_vector.ipp — Inline & Template implementations for Vector<T, N>
// Commonly used in libraries like Boost, Asio, Eigen, and Game Engines
// ============================================================================

#ifndef MATH_VECTOR_IPP
#define MATH_VECTOR_IPP

#include <cmath>
#include <concepts>
#include <cstddef>
#include <stdexcept>
#include <type_traits>

namespace math {

// Declaration of Vector class template
template <typename T, std::size_t N>
    requires std::is_arithmetic_v<T>
class Vector {
    T data_[N];
public:
    constexpr Vector() noexcept;
    constexpr Vector(const T (&values)[N]) noexcept;
    constexpr auto operator[](std::size_t index) noexcept -> T&;
    constexpr auto operator[](std::size_t index) const noexcept -> const T&;
    constexpr auto dot(const Vector<T, N>& other) const noexcept -> T;
    auto magnitude() const -> double;
};

template <typename T, std::size_t N>
    requires std::is_arithmetic_v<T>
inline constexpr Vector<T, N>::Vector() noexcept {
    for (std::size_t i = 0; i < N; ++i) {
        data_[i] = T{0};
    }
}

template <typename T, std::size_t N>
    requires std::is_arithmetic_v<T>
inline constexpr Vector<T, N>::Vector(const T (&values)[N]) noexcept {
    for (std::size_t i = 0; i < N; ++i) {
        data_[i] = values[i];
    }
}

template <typename T, std::size_t N>
    requires std::is_arithmetic_v<T>
inline constexpr auto Vector<T, N>::operator[](std::size_t index) noexcept -> T& {
    return data_[index];
}

template <typename T, std::size_t N>
    requires std::is_arithmetic_v<T>
inline constexpr auto Vector<T, N>::operator[](std::size_t index) const noexcept -> const T& {
    return data_[index];
}

template <typename T, std::size_t N>
    requires std::is_arithmetic_v<T>
inline constexpr auto Vector<T, N>::dot(const Vector<T, N>& other) const noexcept -> T {
    T sum = T{0};
    for (std::size_t i = 0; i < N; ++i) {
        sum += data_[i] * other.data_[i];
    }
    return sum;
}

template <typename T, std::size_t N>
    requires std::is_arithmetic_v<T>
inline auto Vector<T, N>::magnitude() const -> double {
    return std::sqrt(static_cast<double>(this->dot(*this)));
}

template <typename T, std::size_t N>
    requires std::is_arithmetic_v<T>
inline constexpr auto operator+(const Vector<T, N>& lhs, const Vector<T, N>& rhs) noexcept -> Vector<T, N> {
    Vector<T, N> result;
    for (std::size_t i = 0; i < N; ++i) {
        result[i] = lhs[i] + rhs[i];
    }
    return result;
}

} // namespace math

#endif // MATH_VECTOR_IPP
