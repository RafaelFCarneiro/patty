import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Pin currentMonth/currentYear so tests are deterministic
vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return { ...actual, currentMonth: () => 6, currentYear: () => 2024 };
});

// Import after the mock is registered
const { useMonth } = await import('./useMonth');

describe('useMonth', () => {
  it('initialises to the mocked current month and year', () => {
    const { result } = renderHook(() => useMonth());
    expect(result.current.month).toBe(6);
    expect(result.current.year).toBe(2024);
  });

  it('next increments the month', () => {
    const { result } = renderHook(() => useMonth());
    act(() => result.current.next());
    expect(result.current.month).toBe(7);
    expect(result.current.year).toBe(2024);
  });

  it('prev decrements the month', () => {
    const { result } = renderHook(() => useMonth());
    act(() => result.current.prev());
    expect(result.current.month).toBe(5);
    expect(result.current.year).toBe(2024);
  });

  it('next wraps from December to January and bumps the year', () => {
    const { result } = renderHook(() => useMonth());
    // advance from June to December (6 steps)
    act(() => { for (let i = 0; i < 6; i++) result.current.next(); });
    expect(result.current.month).toBe(12);
    act(() => result.current.next());
    expect(result.current.month).toBe(1);
    expect(result.current.year).toBe(2025);
  });

  it('prev wraps from January to December and decrements the year', () => {
    const { result } = renderHook(() => useMonth());
    // retreat from June to January (5 steps)
    act(() => { for (let i = 0; i < 5; i++) result.current.prev(); });
    expect(result.current.month).toBe(1);
    act(() => result.current.prev());
    expect(result.current.month).toBe(12);
    expect(result.current.year).toBe(2023);
  });
});
