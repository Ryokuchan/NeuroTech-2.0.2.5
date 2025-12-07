from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Sequence

import pyautogui
from neurosdk.cmn_types import CallibriEnvelopeData, CallibriSignalData


@dataclass
class MuscleClickConfig:
    # Порог ЛКМ в мкВ - адаптирован для людей с ограниченной моторикой
    left_threshold: float = 150.0  # Снижен для доступности
    # Порог для ПКМ (двойной всплеск)
    right_threshold: float = 250.0  # Снижен для доступности
    # Порог зажатия ЛКМ в мкВ - выше обычного порога
    hold_threshold: float = 225.0  # 1.5x от left_threshold
    # Максимальный интервал между двумя всплесками для ПКМ (секунды).
    right_double_max_gap_sec: float = 1.5  # Увеличен для удобства
    # Общий дебаунс между любыми кликами.
    cooldown_sec: float = 0.5  # Уменьшен для быстродействия
    
    # --- Новые параметры для доступности ---
    # Альтернативный режим: разные мышцы для ЛКМ/ПКМ
    use_separate_muscles: bool = False
    # Порог для второй мышцы (если используется)
    second_muscle_threshold: float = 200.0
    # Режим удержания для drag&drop
    hold_threshold_sec: float = 0.3
    # Чувствительность к длительности сокращения
    use_duration_detection: bool = True


class MuscleClickDetector:
    def __init__(self, config: MuscleClickConfig | None = None) -> None:
        self.config = config or MuscleClickConfig()
        self._last_click_ts: float = 0.0
        self._debug_printed_env: bool = False
        self._debug_printed_sig: bool = False
        # Время последнего всплеска выше порога ПКМ.
        self._last_right_peak_ts: float | None = None
        
        # --- Новые переменные для расширенной функциональности ---
        self._contraction_start_time: float | None = None
        self._is_holding: bool = False
        self._is_dragging: bool = False  # Флаг активного зажатия
        self._muscle_buffer: list[float] = []  # Буфер для анализа паттернов
        self._buffer_max_size: int = 10

    def update_from_envelope(self, data: Sequence[CallibriEnvelopeData]) -> None:
        if not data:
            return

        # В Callibri примере Envelope умножается на 1e6 для перехода к мкВ.
        value = max(abs(d.Sample) * 1e6 for d in data)
        if not self._debug_printed_env:
            print(f"[MuscleClick] envelope max={value:.4f}")
            self._debug_printed_env = True
        if value < self.config.left_threshold:
            return

        now = time.time()
        if now - self._last_click_ts < self.config.cooldown_sec:
            return

        self._last_click_ts = now
        pyautogui.click(button="left")

    def update_from_signal(self, data: Sequence[CallibriSignalData]) -> None:
        if not data:
            return

        # CallibriSignalData.Samples содержат EMG; по образцу sample_callibri
        # масштабируем значения в мкВ (умножаем на 1e6) и берём максимум по модулю.
        max_sample = 0.0
        for pack in data:
            if not pack.Samples:
                continue
            local_max = max(abs(s) * 1e6 for s in pack.Samples)
            if local_max > max_sample:
                max_sample = local_max

        # Обновляем буфер для анализа паттернов
        self._muscle_buffer.append(max_sample)
        if len(self._muscle_buffer) > self._buffer_max_size:
            self._muscle_buffer.pop(0)

        if not self._debug_printed_sig:
            print(f"[MuscleClick] signal max={max_sample:.4f}")
            self._debug_printed_sig = True

        now = time.time()

        # --- Расширенная логика для доступности ---
        if self.config.use_duration_detection:
            self._handle_duration_based_click(max_sample, now)
        else:
            self._handle_simple_click(max_sample, now)

    def _handle_duration_based_click(self, max_sample: float, now: float) -> None:
        """Обработка кликов с учетом длительности сокращения"""
        
        # --- Зажатие ЛКМ - высший приоритет для сильных импульсов ---
        if max_sample >= self.config.hold_threshold:
            if now - self._last_click_ts >= self.config.cooldown_sec:
                self._last_click_ts = now
                
                if not self._is_dragging:
                    # Начинаем зажатие
                    pyautogui.mouseDown(button="left")
                    self._is_dragging = True
                    print(f"[MuscleClick] Left drag START (amp: {max_sample:.1f}µV)")
                else:
                    # Отпускаем зажатие
                    pyautogui.mouseUp(button="left")
                    self._is_dragging = False
                    print(f"[MuscleClick] Left drag END (amp: {max_sample:.1f}µV)")
            return
        
        # --- ПКМ по одному импульсу (средний приоритет) ---
        if max_sample >= self.config.right_threshold:
            if now - self._last_click_ts >= self.config.cooldown_sec:
                self._last_click_ts = now
                pyautogui.click(button="right")
                print(f"[MuscleClick] Right click (amp: {max_sample:.1f}µV)")
            return
        
        # --- ЛКМ по одному импульсу (низкий приоритет) ---
        if max_sample >= self.config.left_threshold:
            if now - self._last_click_ts >= self.config.cooldown_sec:
                self._last_click_ts = now
                pyautogui.click(button="left")
                print(f"[MuscleClick] Left click (amp: {max_sample:.1f}µV)")

    def _handle_simple_click(self, max_sample: float, now: float) -> None:
        """Простая обработка кликов по одному импульсу"""
        
        # --- ПКМ по одному импульсу (высокий приоритет) ---
        if max_sample >= self.config.right_threshold:
            if now - self._last_click_ts >= self.config.cooldown_sec:
                self._last_click_ts = now
                pyautogui.click(button="right")
                print(f"[MuscleClick] Right click (amp: {max_sample:.1f}µV)")
            return
        
        # --- ЛКМ по одному импульсу ---
        if max_sample >= self.config.left_threshold:
            if now - self._last_click_ts >= self.config.cooldown_sec:
                self._last_click_ts = now
                pyautogui.click(button="left")
                print(f"[MuscleClick] Left click (amp: {max_sample:.1f}µV)")
