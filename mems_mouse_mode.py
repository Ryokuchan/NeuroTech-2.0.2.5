from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Optional, Sequence

import pyautogui
from neurosdk.cmn_types import MEMSData


@dataclass
class MemsMouseConfig:
    """Настройки режима управления мышью по MEMS (ускорения XYZ).

    Управление строится на смещении текущего ускорения от калиброванной
    нейтрали. В покое (рука неподвижна) курсор стоит, при резком
    перемещении руки курсор двигается.
    """

    sensitivity_x: float = 900.0   # пикселей на 1 g по оси X датчика
    sensitivity_y: float = 900.0   # пикселей на 1 g по оси Y датчика
    deadzone_g: float = 0.06       # мёртвая зона по ускорению (g)
    neutral_samples: int = 100     # сколько сэмплов усреднять для нейтрали
    update_interval_sec: float = 0.005  # мин. интервал между апдейтами (сек)
    max_step_px: float = 40.0      # ограничение шага курсора за один апдейт
    smooth_alpha: float = 0.25     # коэффициент сглаживания 0..1 (меньше -> плавнее, но с небольшой задержкой)
    center_window_g: float = 0.02  # окно "почти нейтрали" (g), где можно подстраивать нейтраль
    recenter_alpha: float = 0.002  # скорость подстройки нейтрали (очень медленно)
    still_eps_g: float = 0.004     # порог изменения акселерометра, ниже которого считаем, что рука застыла
    gyro_neutral_eps: float = 6.0  # порог по гироскопу (deg/s), ближе к которому считаем позицию исходной
    invert_x: bool = False         # инвертировать ли ось X экрана относительно датчика
    invert_y: bool = False         # инвертировать ли ось Y экрана относительно датчика
    swap_axes: bool = False        # поменять ли местами оси датчика X/Y при проекции на экран


class MemsMouseMode:
    """Режим управления мышью по MEMS XYZ.

    - На старте усредняет несколько значений MEMS (ускорений) и берёт их
      как нейтральное состояние.
    - Для каждого нового пакета MEMS берёт *последний* сэмпл, считает
      разницу accel - neutral и по осям X/Y двигает курсор.

    Важно: здесь используется именно *ускорение*, а не углы. То есть
    курсор двигается пока рука разгоняется / тормозит (движение кисти),
    а в устойчивой неподвижной позе курсор останавливается.
    """

    def __init__(self, config: Optional[MemsMouseConfig] = None) -> None:
        self.config = config or MemsMouseConfig()

        # Нейтральное ускорение (g) в покое
        self._neutral_x: float = 0.0
        self._neutral_y: float = 0.0
        self._neutral_z: float = 0.0

        # Аккумулятор для усреднения
        self._accum_x: float = 0.0
        self._accum_y: float = 0.0
        self._accum_z: float = 0.0
        self._accum_count: int = 0

        # Сглаженные "скорости" по осям (в g), чтобы движение курсора было плавнее
        self._vx_g: float = 0.0
        self._vy_g: float = 0.0

        # Последние значения акселерометра для детекции неподвижности
        self._last_ax: float = 0.0
        self._last_ay: float = 0.0

        # Нейтральное положение гироскопа (угловая скорость в покое)
        self._neutral_gx: float | None = None
        self._neutral_gy: float | None = None
        self._neutral_gz: float | None = None

        # Для ограничения частоты апдейтов
        self._last_update_ts: float = 0.0

        pyautogui.FAILSAFE = False

    # ---------- Публичный API ----------
    def update_mems(self, data: Sequence[MEMSData]) -> None:
        """Обработать новый пакет MEMS-данных.

        SDK присылает список MEMSData; берём последний (самый свежий).
        Ожидается, что MEMSData имеет поля AccelX/AccelY/AccelZ в g.
        """

        if not data:
            return

        m = data[-1]

        # Читаем ускорение из вложенного Point3D Accelerometer (в g)
        try:
            acc = m.Accelerometer
            ax = float(acc.X)
            ay = float(acc.Y)
            az = float(acc.Z)
        except AttributeError:
            # Неподходящая версия SDK / другие имена полей
            return

        # Читаем гироскоп (deg/s) — будем использовать для детекции "исходной" позы
        try:
            gyr = m.Gyroscope
            gx = float(gyr.X)
            gy = float(gyr.Y)
            gz = float(gyr.Z)
        except AttributeError:
            gx = gy = gz = 0.0

        if not (math.isfinite(ax) and math.isfinite(ay) and math.isfinite(az)):
            return

        # Калибровка: первые N сэмплов считаем нейтралью
        if self._accum_count < self.config.neutral_samples:
            self._accum_x += ax
            self._accum_y += ay
            self._accum_z += az
            self._accum_count += 1

            if self._accum_count == self.config.neutral_samples:
                n = float(self._accum_count)
                self._neutral_x = self._accum_x / n
                self._neutral_y = self._accum_y / n
                self._neutral_z = self._accum_z / n
                print("[MemsMouseMode] Neutral acceleration captured")

                # Заодно запоминаем нейтральное состояние гироскопа
                self._neutral_gx = gx
                self._neutral_gy = gy
                self._neutral_gz = gz

            return

        # Ограничиваем частоту обработки, чтобы не спамить pyautogui
        now = time.time()
        if now - self._last_update_ts < self.config.update_interval_sec:
            return
        self._last_update_ts = now

        # Если есть сохранённая нейтраль по гироскопу и мы близко к ней —
        # считаем, что рука вернулась в исходную позу и курсор должен стоять.
        if (
            self._neutral_gx is not None
            and self._neutral_gy is not None
            and self._neutral_gz is not None
        ):
            dgx = gx - self._neutral_gx
            dgy = gy - self._neutral_gy
            dgz = gz - self._neutral_gz
            dist_g = math.sqrt(dgx * dgx + dgy * dgy + dgz * dgz)
            if dist_g < self.config.gyro_neutral_eps:
                # Гасим скорость и не двигаем курсор
                self._vx_g = 0.0
                self._vy_g = 0.0
                self._last_ax = ax
                self._last_ay = ay
                return

        # Проверяем, изменилась ли вообще позиция (ускорение) по сравнению
        # с предыдущим сэмплом. Если почти не изменилась, считаем, что рука
        # "застыла" и курсор должен останавливаться.
        if (
            abs(ax - self._last_ax) < self.config.still_eps_g
            and abs(ay - self._last_ay) < self.config.still_eps_g
        ):
            # Агрессивнее гасим скорость, чтобы курсор мягко останавливался
            self._vx_g *= 0.3
            self._vy_g *= 0.3
            if abs(self._vx_g) < self.config.deadzone_g * 0.5:
                self._vx_g = 0.0
            if abs(self._vy_g) < self.config.deadzone_g * 0.5:
                self._vy_g = 0.0

            dx_g = self._vx_g
            dy_g = self._vy_g

            if dx_g == 0.0 and dy_g == 0.0:
                # Никакого движения курсора не требуется
                self._last_ax = ax
                self._last_ay = ay
                return
        # Смещение ускорения относительно нейтрали
        raw_dx_g = ax - self._neutral_x
        raw_dy_g = ay - self._neutral_y

        # Если мы практически в нейтрали (очень маленькие смещения),
        # медленно подстраиваем нейтраль к текущему положению.
        if (
            abs(raw_dx_g) < self.config.center_window_g
            and abs(raw_dy_g) < self.config.center_window_g
        ):
            r = self.config.recenter_alpha
            self._neutral_x = (1.0 - r) * self._neutral_x + r * ax
            self._neutral_y = (1.0 - r) * self._neutral_y + r * ay
            # пересчитаем смещения относительно обновлённой нейтрали
            raw_dx_g = ax - self._neutral_x
            raw_dy_g = ay - self._neutral_y

        # Мёртвая зона по модулю ускорения
        dz = self.config.deadzone_g
        if abs(raw_dx_g) < dz:
            raw_dx_g = 0.0
        if abs(raw_dy_g) < dz:
            raw_dy_g = 0.0

        # Нелинейный отклик "как у джойстика": за пределами мёртвой зоны
        # скорость растёт быстрее, чем линейно.
        def _joystick_curve(val: float) -> float:
            if val == 0.0:
                return 0.0
            sign = 1.0 if val > 0.0 else -1.0
            mag = abs(val)
            # убираем мёртвую зону и применяем плавную степень
            mag_eff = max(0.0, mag - dz)
            return sign * (mag_eff ** 1.5)

        curved_dx = _joystick_curve(raw_dx_g)
        curved_dy = _joystick_curve(raw_dy_g)

        # Лёгкое сглаживание "скорости" по осям, чтобы убрать дёргание,
        # но не добавлять сильную задержку.
        a = self.config.smooth_alpha
        self._vx_g = (1.0 - a) * self._vx_g + a * curved_dx
        self._vy_g = (1.0 - a) * self._vy_g + a * curved_dy

        dx_g = self._vx_g
        dy_g = self._vy_g

        # Если движение по одной оси сильно доминирует над другой —
        # гасим вторую ось, чтобы не было неожиданных диагональных рывков.
        dom_ratio = 1.5
        if abs(dx_g) > dom_ratio * abs(dy_g):
            dy_g = 0.0
        elif abs(dy_g) > dom_ratio * abs(dx_g):
            dx_g = 0.0

        # Сохраняем текущие значения для проверки неподвижности на следующем шаге
        self._last_ax = ax
        self._last_ay = ay

        # Преобразуем ускорение в движение курсора с учётом ориентации датчика.
        # Сначала можем поменять местами оси датчика, если это нужно.
        sx = dx_g
        sy = dy_g

        if self.config.swap_axes:
            sx, sy = sy, sx

        # Затем инвертируем нужные оси, чтобы добиться интуитивного направления.
        if self.config.invert_x:
            sx = -sx
        if self.config.invert_y:
            sy = -sy

        # Наконец, переводим в пиксели с учётом того, что по Y экрана
        # часто удобнее инвертировать знак (рука вверх -> курсор вверх).
        dx_px = sx * self.config.sensitivity_x
        dy_px = -sy * self.config.sensitivity_y

        # Ограничиваем максимальный шаг курсора за один апдейт
        max_step = self.config.max_step_px
        if dx_px > max_step:
            dx_px = max_step
        elif dx_px < -max_step:
            dx_px = -max_step

        if dy_px > max_step:
            dy_px = max_step
        elif dy_px < -max_step:
            dy_px = -max_step

        if dx_px != 0.0 or dy_px != 0.0:
            pyautogui.moveRel(dx_px, dy_px, duration=0)


@dataclass
class GyroMouseOnlineConfig:
    """ОНЛАЙН версия с минимальной задержкой для реалтайм управления."""
    sensitivity_x: float = 8.0   # повышенная чувствительность по оси Z
    sensitivity_y: float = 8.0   # повышенная чувствительность по оси X
    neutral_samples: int = 50    # быстрее калибровка
    update_interval_sec: float = 0.004  # оптимально (~250 Гц)
    deadzone_deg: float = 2.0    # больше мёртвая зона - игнорировать микро-колебания
    max_step_px: float = 50.0    # увеличенный максимальный шаг для скорости
    smooth_alpha: float = 0.8   # МИНИМАЛЬНОЕ сглаживание - почти реалтайм
    center_eps_deg: float = 1.0   # шире окно центра - игнорировать микро-колебания
    recenter_alpha: float = 0.002 # чуть быстрее подстройка
    still_eps_deg: float = 0.5    # увеличенный порог - игнорировать микро-колебания
    still_timeout_sec: float = 0.1 # МГНОВЕННАЯ остановка - 0.1 сек
    # EMG фильтр
    emg_threshold: float = 5.0    # очень низкий порог - почти всегда активен
    emg_smooth_alpha: float = 0.4  # сглаживание EMG


class GyroMouseOnlineMode:
    """ОНЛАЙН версия с МИНИМАЛЬНОЙ задержкой для реалтайм управления.
    
    Ключевые отличия от обычной версии:
    - Минимальное сглаживание (smooth_alpha = 0.8)
    - Мгновенная остановка (still_timeout_sec = 0.1)
    - EMG-фильтр для активации курсора
    - Оптимизированная частота обновлений
    """

    def __init__(self, config: Optional[GyroMouseOnlineConfig] = None) -> None:
        self.config = config or GyroMouseOnlineConfig()

        self._neutral_gx: float = 0.0
        self._neutral_gz: float = 0.0
        self._accum_gx: float = 0.0
        self._accum_gz: float = 0.0
        self._accum_count: int = 0

        self._vx: float = 0.0
        self._vy: float = 0.0
        self._last_update_ts: float = 0.0
        self._last_gx: float = 0.0
        self._last_gz: float = 0.0
        self._still_since: float = 0.0
        self._last_gyro_time: float = 0.0
        
        # EMG фильтр для плавности
        self._emg_smooth: float = 0.0
        self._emg_active: bool = False

        pyautogui.FAILSAFE = False

    def update_emg(self, envelope_value: float) -> None:
        """Обновить EMG огибающую для фильтрации движений курсора."""
        # Сглаживаем EMG
        a = self.config.emg_smooth_alpha
        self._emg_smooth = (1.0 - a) * self._emg_smooth + a * envelope_value
        
        # Активируем курсор только при превышении порога
        self._emg_active = self._emg_smooth >= self.config.emg_threshold

    def update_mems(self, data: Sequence[MEMSData]) -> None:
        if not data:
            return

        m = data[-1]
        try:
            gyr = m.Gyroscope
            gx = float(gyr.X)
            gz = float(gyr.Z)
        except AttributeError:
            return

        if not (math.isfinite(gx) and math.isfinite(gz)):
            return

        # Быстрая калибровка нейтрали
        if self._accum_count < self.config.neutral_samples:
            self._accum_gx += gx
            self._accum_gz += gz
            self._accum_count += 1
            if self._accum_count == self.config.neutral_samples:
                n = float(self._accum_count)
                self._neutral_gx = self._accum_gx / n
                self._neutral_gz = self._accum_gz / n
                print("[GyroMouseOnlineMode] Neutral gyro captured")
            return

        now = time.time()
        if now - self._last_update_ts < self.config.update_interval_sec:
            return
        self._last_update_ts = now

        # ФИЛЬТР быстрых колебаний - игнорировать слишком резкие изменения
        if self._last_gyro_time > 0:
            dt = now - self._last_gyro_time
            if dt < 0.01:  # если пришло слишком быстро
                # Проверяем насколько сильно изменился гироскоп
                dgx = abs(gx - self._last_gx)
                dgz = abs(gz - self._last_gz)
                # Если изменение слишком резкое - игнорируем
                if dgx > 5.0 or dgz > 5.0:
                    self._last_gyro_time = now
                    return
        self._last_gyro_time = now

        # ОНЛАЙН: двигаем курсор только если EMG активна (временно отключено)
        # if not self._emg_active:
        #     return

        dx_deg = gz - self._neutral_gz
        dy_deg = gx - self._neutral_gx

        # МГНОВЕННАЯ остановка - усиленная
        if (
            abs(gx - self._last_gx) < self.config.still_eps_deg
            and abs(gz - self._last_gz) < self.config.still_eps_deg
        ):
            if self._still_since == 0.0:
                self._still_since = now
            elif now - self._still_since >= self.config.still_timeout_sec:
                # АГРЕССИВНОЕ торможение до полной остановки
                self._vx *= 0.05
                self._vy *= 0.05
                if abs(self._vx) < 0.01:
                    self._vx = 0.0
                if abs(self._vy) < 0.01:
                    self._vy = 0.0
                self._last_gx = gx
                self._last_gz = gz
                return
        else:
            self._still_since = 0.0

        self._last_gx = gx
        self._last_gz = gz

        # Центр - усиленное торможение для стабильности
        if (
            abs(dx_deg) < self.config.center_eps_deg
            and abs(dy_deg) < self.config.center_eps_deg
        ):
            # МГНОВЕННАЯ остановка в центре
            self._vx *= 0.02
            self._vy *= 0.02
            if abs(self._vx) < 0.01:
                self._vx = 0.0
            if abs(self._vy) < 0.01:
                self._vy = 0.0
            return

        # Мёртвая зона
        if abs(dx_deg) < self.config.deadzone_deg:
            dx_deg = 0.0
        if abs(dy_deg) < self.config.deadzone_deg:
            dy_deg = 0.0

        # МИНИМАЛЬНОЕ сглаживание - почти реалтайм
        a = self.config.smooth_alpha
        self._vx = (1.0 - a) * self._vx + a * dx_deg
        self._vy = (1.0 - a) * self._vy + a * dy_deg
        
        # ДОПОЛНИТЕЛЬНОЕ сглаживание для стабильности
        self._vx *= 0.95
        self._vy *= 0.95

        # ПРЯМОЕ движение без кривых
        dx_px = -self._vx * self.config.sensitivity_x
        dy_px = -self._vy * self.config.sensitivity_y

        # Ограничение шага
        max_step = self.config.max_step_px
        if dx_px > max_step:
            dx_px = max_step
        elif dx_px < -max_step:
            dx_px = -max_step

        if dy_px > max_step:
            dy_px = max_step
        elif dy_px < -max_step:
            dy_px = -max_step

        if dx_px != 0.0 or dy_px != 0.0:
            pyautogui.moveRel(dx_px, dy_px, duration=0)


class GyroMouseMode:
    """Управление мышью только по гироскопу (X/Z), как в простом скрипте.

    dx ~ -(gz - gz0) * sensitivity_x
    dy ~ -(gx - gx0) * sensitivity_y
    """

    def __init__(self, config: Optional[GyroMouseConfig] = None) -> None:
        self.config = config or GyroMouseConfig()

        self._neutral_gx: float = 0.0
        self._neutral_gz: float = 0.0
        self._accum_gx: float = 0.0
        self._accum_gz: float = 0.0
        self._accum_count: int = 0

        self._vx: float = 0.0
        self._vy: float = 0.0
        self._last_update_ts: float = 0.0
        self._last_gx: float = 0.0
        self._last_gz: float = 0.0
        self._still_since: float = 0.0
        
        # EMG фильтр для плавности
        self._emg_smooth: float = 0.0
        self._emg_active: bool = False

        pyautogui.FAILSAFE = False

    def update_emg(self, envelope_value: float) -> None:
        """Обновить EMG огибающую для фильтрации движений курсора."""
        # Сглаживаем EMG
        a = self.config.emg_smooth_alpha
        self._emg_smooth = (1.0 - a) * self._emg_smooth + a * envelope_value
        
        # Активируем курсор только при превышении порога
        self._emg_active = self._emg_smooth >= self.config.emg_threshold

    def update_mems(self, data: Sequence[MEMSData]) -> None:
        if not data:
            return

        m = data[-1]
        try:
            gyr = m.Gyroscope
            gx = float(gyr.X)
            gz = float(gyr.Z)
        except AttributeError:
            return

        if not (math.isfinite(gx) and math.isfinite(gz)):
            return

        # Калибровка нейтрали гироскопа
        if self._accum_count < self.config.neutral_samples:
            self._accum_gx += gx
            self._accum_gz += gz
            self._accum_count += 1
            if self._accum_count == self.config.neutral_samples:
                n = float(self._accum_count)
                self._neutral_gx = self._accum_gx / n
                self._neutral_gz = self._accum_gz / n
                print("[GyroMouseMode] Neutral gyro captured")
            return

        now = time.time()
        if now - self._last_update_ts < self.config.update_interval_sec:
            return
        self._last_update_ts = now

        dx_deg = gz - self._neutral_gz
        dy_deg = gx - self._neutral_gx

        # Проверяем, изменился ли гироскоп (для остановки)
        if (
            abs(gx - self._last_gx) < self.config.still_eps_deg
            and abs(gz - self._last_gz) < self.config.still_eps_deg
        ):
            if self._still_since == 0.0:
                self._still_since = now
            elif now - self._still_since >= self.config.still_timeout_sec:
                # Гасим скорость и не двигаем курсор
                self._vx *= 0.2
                self._vy *= 0.2
                if abs(self._vx) < 0.1:
                    self._vx = 0.0
                if abs(self._vy) < 0.1:
                    self._vy = 0.0
                self._last_gx = gx
                self._last_gz = gz
                return
        else:
            self._still_since = 0.0

        self._last_gx = gx
        self._last_gz = gz

        # Если мы почти в центре стика — гасим скорость и не двигаем курсор.
        if (
            abs(dx_deg) < self.config.center_eps_deg
            and abs(dy_deg) < self.config.center_eps_deg
        ):
            self._vx *= 0.2
            self._vy *= 0.2
            if abs(self._vx) < 0.1:
                self._vx = 0.0
            if abs(self._vy) < 0.1:
                self._vy = 0.0

            if self._vx == 0.0 and self._vy == 0.0:
                # Лёгкая автоподстройка нейтрали, чтобы компенсировать дрейф.
                r = self.config.recenter_alpha
                self._neutral_gx = (1.0 - r) * self._neutral_gx + r * gx
                self._neutral_gz = (1.0 - r) * self._neutral_gz + r * gz
                return

        # Мёртвая зона
        if abs(dx_deg) < self.config.deadzone_deg:
            dx_deg = 0.0
        if abs(dy_deg) < self.config.deadzone_deg:
            dy_deg = 0.0

        # Лёгкое сглаживание
        a = self.config.smooth_alpha
        self._vx = (1.0 - a) * self._vx + a * dx_deg
        self._vy = (1.0 - a) * self._vy + a * dy_deg

        # Нелинейное ускорение "как у стика": малые наклоны -> медленно, сильные -> быстрее
        def _joystick_curve(val: float) -> float:
            if val == 0.0:
                return 0.0
            sign = 1.0 if val > 0.0 else -1.0
            mag = abs(val)
            return sign * (mag ** 1.6)

        curved_dx = _joystick_curve(self._vx)
        curved_dy = _joystick_curve(self._vy)

        dx_px = -curved_dx * self.config.sensitivity_x
        dy_px = -curved_dy * self.config.sensitivity_y

        max_step = self.config.max_step_px
        if dx_px > max_step:
            dx_px = max_step
        elif dx_px < -max_step:
            dx_px = -max_step

        if dy_px > max_step:
            dy_px = max_step
        elif dy_px < -max_step:
            dy_px = -max_step

        if dx_px != 0.0 or dy_px != 0.0:
            pyautogui.moveRel(dx_px, dy_px, duration=0)
