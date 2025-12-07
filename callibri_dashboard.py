from __future__ import annotations

import sys
import os

# Добавляем путь к src директории для импортов
if getattr(sys, 'frozen', False):
    # Если запущено как exe
    application_path = os.path.dirname(sys.executable)
    src_path = os.path.join(application_path, 'src')
else:
    # Если запущено как скрипт
    src_path = os.path.join(os.path.dirname(__file__), '..')

if src_path not in sys.path:
    sys.path.insert(0, src_path)

import threading
from collections import deque
from typing import Deque, Sequence

from PyQt5 import QtCore, QtWidgets
import pyqtgraph as pg
from neurosdk.cmn_types import MEMSData, QuaternionData, CallibriEnvelopeData, CallibriSignalData

from callibri_sdk.sensor_stream import CallibriStream, CallibriStreamConfig
from control.mems_mouse_mode import GyroMouseOnlineMode, GyroMouseOnlineConfig
from control.muscle_click import MuscleClickDetector, MuscleClickConfig


class ThresholdDialog(QtWidgets.QDialog):
    """Диалог настройки порогов EMG сигнала"""
    
    def __init__(self, parent=None, initial_left=150.0, initial_right=250.0):
        super().__init__(parent)
        self.setWindowTitle("Настройка порогов EMG")
        self.setModal(True)
        self.resize(800, 600)
        
                
        # Текущие пороги
        self.left_threshold = initial_left
        self.right_threshold = initial_right
        self.hold_threshold = initial_left * 1.5 if initial_left else 225.0
        
        # Данные для графиков
        self.max_points = 500
        self.emg_data = deque(maxlen=self.max_points)
        self.time_data = deque(maxlen=self.max_points)
        self.start_time = 0
        
        # Статистика
        self.max_emg = 0.0
        self.avg_emg = 0.0
        self.samples_count = 0
        
        # Стрим сенсора
        self.stream = None
        
        self.setup_ui()
        
    def setup_ui(self):
        layout = QtWidgets.QVBoxLayout(self)
        
        # Информационная панель
        info_layout = QtWidgets.QHBoxLayout()
        
        self.status_label = QtWidgets.QLabel("Статус: остановлено")
        self.max_label = QtWidgets.QLabel("Макс: 0.0 мкВ")
        self.avg_label = QtWidgets.QLabel("Среднее: 0.0 мкВ")
        
        info_layout.addWidget(self.status_label)
        info_layout.addWidget(self.max_label)
        info_layout.addWidget(self.avg_label)
        info_layout.addStretch()
        
        layout.addLayout(info_layout)
        
        # Контролы порогов
        threshold_layout = QtWidgets.QGridLayout()
        
        threshold_layout.addWidget(QtWidgets.QLabel("Порог ЛКМ:"), 0, 0)
        self.left_threshold_spin = QtWidgets.QDoubleSpinBox()
        self.left_threshold_spin.setRange(10.0, 1000.0)
        self.left_threshold_spin.setValue(self.left_threshold)
        self.left_threshold_spin.setSuffix(" мкВ")
        self.left_threshold_spin.valueChanged.connect(self.update_left_threshold)
        threshold_layout.addWidget(self.left_threshold_spin, 0, 1)
        
        threshold_layout.addWidget(QtWidgets.QLabel("Порог зажатия ЛКМ:"), 1, 0)
        self.hold_threshold_spin = QtWidgets.QDoubleSpinBox()
        self.hold_threshold_spin.setRange(10.0, 1000.0)
        self.hold_threshold_spin.setValue(self.hold_threshold)
        self.hold_threshold_spin.setSuffix(" мкВ")
        self.hold_threshold_spin.valueChanged.connect(self.update_hold_threshold)
        threshold_layout.addWidget(self.hold_threshold_spin, 1, 1)
        
        threshold_layout.addWidget(QtWidgets.QLabel("Порог ПКМ:"), 2, 0)
        self.right_threshold_spin = QtWidgets.QDoubleSpinBox()
        self.right_threshold_spin.setRange(10.0, 1000.0)
        self.right_threshold_spin.setValue(self.right_threshold)
        self.right_threshold_spin.setSuffix(" мкВ")
        self.right_threshold_spin.valueChanged.connect(self.update_right_threshold)
        threshold_layout.addWidget(self.right_threshold_spin, 2, 1)
        
        layout.addLayout(threshold_layout)
        
        # График EMG
        self.plot_widget = pg.GraphicsLayoutWidget()
        self.plot_widget.setMinimumHeight(500)  # Увеличиваем высоту графика
        self.plot = self.plot_widget.addPlot(title="EMG Сигнал (мкВ)")
        self.plot.showGrid(x=True, y=True)
        self.plot.setLabel('left', 'Амплитуда', 'мкВ')
        self.plot.setLabel('bottom', 'Время', 'с')
        
        self.curve = self.plot.plot(pen='y')
        
        # Линии порогов
        self.left_line = pg.InfiniteLine(pos=self.left_threshold, angle=0, pen='r', movable=False)
        self.hold_line = pg.InfiniteLine(pos=self.hold_threshold, angle=0, pen='orange', movable=False)
        self.right_line = pg.InfiniteLine(pos=self.right_threshold, angle=0, pen='b', movable=False)
        self.plot.addItem(self.left_line)
        self.plot.addItem(self.hold_line)
        self.plot.addItem(self.right_line)
        
        layout.addWidget(self.plot_widget)
        
        # Кнопки управления
        control_layout = QtWidgets.QHBoxLayout()
        
        self.start_button = QtWidgets.QPushButton("Начать тест")
        self.stop_button = QtWidgets.QPushButton("Остановить")
        self.stop_button.setEnabled(False)
        self.reset_button = QtWidgets.QPushButton("Сброс")
        
                
        self.start_button.clicked.connect(self.start_test)
        self.stop_button.clicked.connect(self.stop_test)
        self.reset_button.clicked.connect(self.reset_data)
        
        control_layout.addWidget(self.start_button)
        control_layout.addWidget(self.stop_button)
        control_layout.addWidget(self.reset_button)
        control_layout.addStretch()
        
        layout.addLayout(control_layout)
        
        # Инструкции
        instructions = QtWidgets.QLabel(
            "Инструкции:\n"
            "1. Нажмите 'Начать тест'\n"
            "2. Расслабьте руку - будет показан фоновый уровень\n"
            "3. Сделайте легкое сокращение - посмотрите на пики\n"
            "4. Настройте пороги так, чтобы они были выше фона, но ниже пиков\n"
            "5. ЛКМ: короткое сокращение, ПКМ: длительное сокращение"
        )
        instructions.setWordWrap(True)
        layout.addWidget(instructions)
        
        # Кнопки диалога
        dialog_buttons = QtWidgets.QHBoxLayout()
        
        self.apply_button = QtWidgets.QPushButton("Применить")
        self.cancel_button = QtWidgets.QPushButton("Отмена")
        
                
        self.apply_button.clicked.connect(self.accept)
        self.cancel_button.clicked.connect(self.reject)
        
        dialog_buttons.addStretch()
        dialog_buttons.addWidget(self.apply_button)
        dialog_buttons.addWidget(self.cancel_button)
        
        layout.addLayout(dialog_buttons)
        
        # Таймер обновления
        self.timer = QtCore.QTimer()
        self.timer.setInterval(50)  # 20 Гц
        self.timer.timeout.connect(self.update_plot)
        
    def update_left_threshold(self, value):
        self.left_threshold = value
        self.left_line.setPos(value)
        
    def update_right_threshold(self, value):
        self.right_threshold = value
        self.right_line.setPos(value)
        
    def update_hold_threshold(self, value):
        self.hold_threshold = value
        self.hold_line.setPos(value)
        
    def start_test(self):
        self.status_label.setText("Статус: поиск сенсора...")
        QtWidgets.QApplication.processEvents()
        
        self.reset_data()
        self.start_time = 0
        
        try:
            self.stream = CallibriStream(CallibriStreamConfig(search_timeout_sec=5))
            self.stream.start(
                on_mems=self._dummy_mems,
                on_quat=self._dummy_quat,
                on_envelope=self._dummy_envelope,
                on_signal=self._on_signal
            )
            
            self.status_label.setText("Статус: запись...")
            self.start_button.setEnabled(False)
            self.stop_button.setEnabled(True)
            self.timer.start()
            
        except Exception as e:
            self.status_label.setText(f"Ошибка: {e}")
            
    def stop_test(self):
        if self.stream:
            try:
                self.stream.stop()
            except:
                pass
            self.stream = None
            
        self.timer.stop()
        self.status_label.setText("Статус: остановлено")
        self.start_button.setEnabled(True)
        self.stop_button.setEnabled(False)
        
    def reset_data(self):
        self.emg_data.clear()
        self.time_data.clear()
        self.max_emg = 0.0
        self.avg_emg = 0.0
        self.samples_count = 0
        self.update_stats()
        
    def _dummy_mems(self, stream, data): pass
    def _dummy_quat(self, stream, data): pass
    def _dummy_envelope(self, stream, data): pass
        
    def _on_signal(self, stream, data):
        if not data:
            return
            
        max_sample = 0.0
        for pack in data:
            if not pack.Samples:
                continue
            local_max = max(abs(s) * 1e6 for s in pack.Samples)
            if local_max > max_sample:
                max_sample = local_max
                
        if self.start_time == 0:
            self.start_time = QtCore.QTime.currentTime().msecsSinceStartOfDay() / 1000.0
            
        current_time = QtCore.QTime.currentTime().msecsSinceStartOfDay() / 1000.0 - self.start_time
        
        self.emg_data.append(max_sample)
        self.time_data.append(current_time)
        
        # Обновляем статистику
        self.max_emg = max(self.max_emg, max_sample)
        self.samples_count += 1
        self.avg_emg = (self.avg_emg * (self.samples_count - 1) + max_sample) / self.samples_count
        
    def update_plot(self):
        if not self.time_data:
            return
            
        self.curve.setData(list(self.time_data), list(self.emg_data))
        self.update_stats()
        
    def update_stats(self):
        self.max_label.setText(f"Макс: {self.max_emg:.1f} мкВ")
        self.avg_label.setText(f"Среднее: {self.avg_emg:.1f} мкВ")
        
    def get_thresholds(self):
        """Возвращает настроенные пороги"""
        return self.left_threshold, self.right_threshold, self.hold_threshold
        
    def closeEvent(self, event):
        """Очистка при закрытии диалога"""
        self.stop_test()
        super().closeEvent(event)


class CallibriDashboard(QtWidgets.QMainWindow):
    def __init__(self) -> None:
        super().__init__()

        self.setWindowTitle("Панель управления Callibri")
        self.resize(1200, 800)
        
        # Применяем современный стиль ко всему окну
        self.setStyleSheet("""
            QMainWindow {
                background-color: #FFFFFF;
                border: 2px solid #1976D2;
            }
            QWidget {
                background-color: #FFFFFF;
                color: #212121;
                font-family: 'Segoe UI', Arial, sans-serif;
                font-size: 12pt;
            }
            QLabel {
                color: #212121;
                font-weight: 500;
            }
        """)

        # --- состояние стрима и режимов управления ---
        self._stream: CallibriStream | None = None
        self._lock = threading.Lock()

        # Режим управления мышью ОНЛАЙН с минимальной задержкой
        self._mems_mouse = GyroMouseOnlineMode(
            GyroMouseOnlineConfig(
                sensitivity_x=3.2,  # Увеличиваем чувствительность 
                sensitivity_y=3.2,  # Увеличиваем чувствительность 
                neutral_samples=100,  # Больше сэмплов для калибровки
                update_interval_sec=0.000142857,  # 200 Гц - снижаем частоту для стабильности
                deadzone_deg=1.0,  # Значительно увеличиваем мертвую зону
                max_step_px=40.0,  # Увеличиваем максимальный 
                smooth_alpha=0.88,  # Сильное сглаживание
                still_eps_deg=0.9,  # Увеличиваем порог определения остановки
                center_eps_deg=1.2,  # Большая центральная зона
            )
        )

        # Загружаем сохраненные пороги или используем значения по умолчанию
        saved_left, saved_right, saved_hold = self._load_saved_thresholds()
        
        # Детектор мышечных кликов с загруженными порогами
        self._muscle_click = MuscleClickDetector(
            MuscleClickConfig(
                left_threshold=saved_left,      # Загруженный порог ЛКМ
                right_threshold=saved_right,    # Загруженный порог ПКМ
                hold_threshold=saved_hold,      # Загруженный порог зажатия
                cooldown_sec=0.5,               # Уменьшен для быстродействия
                right_double_max_gap_sec=1.5,   # Увеличен для удобства
                use_duration_detection=True,    # Режим длительности вместо двойного клика
                hold_threshold_sec=0.3,        # 0.3с для ЛКМ, >0.3с для ПКМ
            )
        )

        # Очереди данных (ограниченная длина для графиков)
        self._max_points = 1000
        self._emg_env: Deque[float] = deque(maxlen=self._max_points)
        self._emg_sig: Deque[float] = deque(maxlen=self._max_points)
        self._acc_x: Deque[float] = deque(maxlen=self._max_points)
        self._acc_y: Deque[float] = deque(maxlen=self._max_points)
        self._acc_z: Deque[float] = deque(maxlen=self._max_points)
        self._gyr_x: Deque[float] = deque(maxlen=self._max_points)
        self._gyr_y: Deque[float] = deque(maxlen=self._max_points)
        self._gyr_z: Deque[float] = deque(maxlen=self._max_points)

        # --- UI ---
        central = QtWidgets.QWidget(self)
        self.setCentralWidget(central)

        layout = QtWidgets.QVBoxLayout(central)

        # Кнопки управления
        controls_layout = QtWidgets.QHBoxLayout()
        self.start_button = QtWidgets.QPushButton("Старт")
        self.stop_button = QtWidgets.QPushButton("Стоп")
        self.stop_button.setEnabled(False)
        self.threshold_button = QtWidgets.QPushButton("Настроить пороги")
        
        # Стилизация кнопок - синие и белые тона
        button_style = """
        QPushButton {
            background-color: #1976D2;
            color: white;
            border: 2px solid #ffffff;
            padding: 12px 24px;
            font-size: 14px;
            font-weight: bold;
            border-radius: 8px;
            min-width: 120px;
        }
        QPushButton:hover {
            background-color: #2196F3;
            border-color: #e3f2fd;
        }
        QPushButton:pressed {
            background-color: #1565C0;
            border-color: #bbdefb;
        }
        QPushButton:disabled {
            background-color: #e3f2fd;
            color: #90caf9;
            border-color: #ffffff;
        }
        """
        
        stop_button_style = """
        QPushButton {
            background-color: #ffffff;
            color: #1976D2;
            border: 2px solid #1976D2;
            padding: 12px 24px;
            font-size: 14px;
            font-weight: bold;
            border-radius: 8px;
            min-width: 120px;
        }
        QPushButton:hover {
            background-color: #e3f2fd;
            color: #1565C0;
            border-color: #1565C0;
        }
        QPushButton:pressed {
            background-color: #bbdefb;
            color: #0d47a1;
            border-color: #0d47a1;
        }
        QPushButton:disabled {
            background-color: #f5f5f5;
            color: #90caf9;
            border-color: #e3f2fd;
        }
        """
        
        threshold_button_style = """
        QPushButton {
            background-color: #ffffff;
            color: #1976D2;
            border: 2px solid #1976D2;
            padding: 12px 24px;
            font-size: 14px;
            font-weight: bold;
            border-radius: 8px;
            min-width: 120px;
        }
        QPushButton:hover {
            background-color: #e3f2fd;
            color: #1565C0;
            border-color: #1565C0;
        }
        QPushButton:pressed {
            background-color: #bbdefb;
            color: #0d47a1;
            border-color: #0d47a1;
        }
        QPushButton:disabled {
            background-color: #f5f5f5;
            color: #90caf9;
            border-color: #e3f2fd;
        }
        """
        
        self.start_button.setStyleSheet(button_style)
        self.stop_button.setStyleSheet(stop_button_style)
        self.threshold_button.setStyleSheet(threshold_button_style)

        controls_layout.addWidget(self.start_button)
        controls_layout.addWidget(self.stop_button)
        controls_layout.addWidget(self.threshold_button)
        controls_layout.addStretch(1)

        layout.addLayout(controls_layout)

        # Текстовый статус
        self.status_label = QtWidgets.QLabel("Статус: остановлено")
        self.status_label.setWordWrap(True)
        layout.addWidget(self.status_label)
        
        # Информация о порогах
        self.threshold_info_label = QtWidgets.QLabel(
            f"Пороги: ЛКМ={self._muscle_click.config.left_threshold:.1f} мкВ, "
            f"ПКМ={self._muscle_click.config.right_threshold:.1f} мкВ"
        )
        self.threshold_info_label.setStyleSheet("color: gray; font-size: 10pt;")
        layout.addWidget(self.threshold_info_label)

        # Графики
        plots_layout = QtWidgets.QHBoxLayout()

        # MEMS график: акселерометр + гироскоп
        mems_widget = pg.GraphicsLayoutWidget()
        self.acc_plot = mems_widget.addPlot(row=0, col=0, title="Акселерометр (g)")
        self.acc_plot.addLegend()
        # Синие очертания для графика акселерометра
        self.acc_plot.showGrid(x=True, y=True, alpha=0.3)
        self.acc_plot.getAxis('left').setPen('#1976D2')
        self.acc_plot.getAxis('bottom').setPen('#1976D2')
        self.acc_plot.getAxis('left').setTextPen('#1976D2')
        self.acc_plot.getAxis('bottom').setTextPen('#1976D2')
        self.acc_x_curve = self.acc_plot.plot(pen="#1976D2", name="Ax")
        self.acc_y_curve = self.acc_plot.plot(pen="#2196F3", name="Ay")
        self.acc_z_curve = self.acc_plot.plot(pen="#64B5F6", name="Az")

        self.gyr_plot = mems_widget.addPlot(row=1, col=0, title="Гироскоп (град/с)")
        self.gyr_plot.addLegend()
        # Синие очертания для графика гироскопа
        self.gyr_plot.showGrid(x=True, y=True, alpha=0.3)
        self.gyr_plot.getAxis('left').setPen('#1976D2')
        self.gyr_plot.getAxis('bottom').setPen('#1976D2')
        self.gyr_plot.getAxis('left').setTextPen('#1976D2')
        self.gyr_plot.getAxis('bottom').setTextPen('#1976D2')
        self.gyr_x_curve = self.gyr_plot.plot(pen="#1976D2", name="Gx")
        self.gyr_y_curve = self.gyr_plot.plot(pen="#2196F3", name="Gy")
        self.gyr_z_curve = self.gyr_plot.plot(pen="#64B5F6", name="Gz")

        # EMG график: Envelope + Signal max
        emg_widget = pg.GraphicsLayoutWidget()
        self.env_plot = emg_widget.addPlot(row=0, col=0, title="Огибающая EMG (у.е.)")
        # Синие очертания для графика огибающей EMG
        self.env_plot.showGrid(x=True, y=True, alpha=0.3)
        self.env_plot.getAxis('left').setPen('#1976D2')
        self.env_plot.getAxis('bottom').setPen('#1976D2')
        self.env_plot.getAxis('left').setTextPen('#1976D2')
        self.env_plot.getAxis('bottom').setTextPen('#1976D2')
        self.env_curve = self.env_plot.plot(pen="#1976D2")

        self.sig_plot = emg_widget.addPlot(row=1, col=0, title="Максимум сигнала EMG (у.е.)")
        # Синие очертания для графика сигнала EMG
        self.sig_plot.showGrid(x=True, y=True, alpha=0.3)
        self.sig_plot.getAxis('left').setPen('#1976D2')
        self.sig_plot.getAxis('bottom').setPen('#1976D2')
        self.sig_plot.getAxis('left').setTextPen('#1976D2')
        self.sig_plot.getAxis('bottom').setTextPen('#1976D2')
        self.sig_curve = self.sig_plot.plot(pen="#2196F3")

        plots_layout.addWidget(mems_widget, 1)
        plots_layout.addWidget(emg_widget, 1)

        layout.addLayout(plots_layout, 1)

        # Таймер обновления графиков
        self._timer = QtCore.QTimer(self)
        self._timer.setInterval(50)  # мс
        self._timer.timeout.connect(self._update_plots)

        # Сигналы
        self.start_button.clicked.connect(self._on_start_clicked)
        self.stop_button.clicked.connect(self._on_stop_clicked)
        self.threshold_button.clicked.connect(self._on_threshold_clicked)

    # --- управление стримом ---
    def _on_start_clicked(self) -> None:
        if self._stream is not None:
            return

        self.status_label.setText("Статус: поиск датчика Callibri...")
        QtWidgets.QApplication.processEvents()

        try:
            cfg = CallibriStreamConfig(search_timeout_sec=5)
            self._stream = CallibriStream(cfg)

            self._stream.start(
                on_mems=self._safe_mems_callback,
                on_quat=self._safe_quat_callback,
                on_envelope=self._safe_envelope_callback,
                on_signal=self._safe_signal_callback,
            )
            self.status_label.setText("Статус: поток данных с Callibri")
            self.start_button.setEnabled(False)
            self.stop_button.setEnabled(True)
            self._timer.start()
        except Exception as err:
            self.status_label.setText(f"Статус: ошибка запуска потока: {err}")
            self._stream = None
            # Не даем программе упасть
            import traceback
            print(f"Ошибка запуска: {traceback.format_exc()}")

    def _on_stop_clicked(self) -> None:
        if self._stream is None:
            return
        try:
            self._stream.stop()
        except Exception:
            pass  # Игнорируем ошибки при остановке
        finally:
            self._stream = None
            self.start_button.setEnabled(True)
            self.stop_button.setEnabled(False)
            self.status_label.setText("Статус: остановлено")
            try:
                self._timer.stop()
            except Exception:
                pass

    def _load_saved_thresholds(self) -> tuple[float, float, float]:
        """Загрузить сохраненные пороги из файла конфигурации"""
        try:
            import json
            
            # Путь к файлу конфигурации
            config_path = os.path.join(os.path.dirname(__file__), '..', 'control', 'threshold_config.json')
            
            # Проверяем существование файла
            if os.path.exists(config_path):
                with open(config_path, 'r', encoding='utf-8') as f:
                    config_data = json.load(f)
                    
                left_threshold = config_data.get('left_threshold', 550.0)
                right_threshold = config_data.get('right_threshold', 220.0)
                hold_threshold = config_data.get('hold_threshold', 825.0)
                
                print(f"Загружены пороги: ЛКМ={left_threshold:.1f} мкВ, Зажатие={hold_threshold:.1f} мкВ, ПКМ={right_threshold:.1f} мкВ")
                return float(left_threshold), float(right_threshold), float(hold_threshold)
            else:
                print("Файл конфигурации порогов не найден, используются значения по умолчанию")
                return 550.0, 220.0, 825.0
                
        except Exception as e:
            print(f"Ошибка загрузки порогов: {e}, используются значения по умолчанию")
            return 550.0, 220.0, 825.0

    def _on_threshold_clicked(self) -> None:
        """Открыть диалог настройки порогов"""
        # Показываем уведомление о необходимости переподключения
        QtWidgets.QMessageBox.information(
            self, 
            "Настройка порогов", 
            "Для настройки порогов будет создано отдельное соединение с датчиком.\n"
            "После завершения настройки основное соединение будет восстановлено автоматически."
        )
        
        # Останавливаем основной стрим если он активен
        was_streaming = self._stream is not None
        if was_streaming:
            self._on_stop_clicked()
        
        # Получаем текущие пороги из конфигурации
        current_left = self._muscle_click.config.left_threshold
        current_right = self._muscle_click.config.right_threshold
        current_hold = self._muscle_click.config.hold_threshold
        
        # Создаем и показываем диалог
        dialog = ThresholdDialog(self, current_left, current_right)
        dialog.hold_threshold = current_hold
        dialog.hold_threshold_spin.setValue(current_hold)
        dialog.hold_line.setPos(current_hold)
        
        if dialog.exec_() == QtWidgets.QDialog.Accepted:
            # Получаем новые пороги
            new_left, new_right, new_hold = dialog.get_thresholds()
            
            # Обновляем конфигурацию
            self._update_thresholds(new_left, new_right, new_hold)
            
            # Показываем уведомление
            self.status_label.setText(
                f"Пороги обновлены: ЛКМ={new_left:.1f} мкВ, Зажатие={new_hold:.1f} мкВ, ПКМ={new_right:.1f} мкВ"
            )
        else:
            self.status_label.setText("Настройка порогов отменена")
        
        # Восстанавливаем основной стрим если он был активен
        if was_streaming:
            QtCore.QTimer.singleShot(1000, self._on_start_clicked)  # Задержка 1 секунда
    
    def _update_thresholds(self, left_threshold: float, right_threshold: float, hold_threshold: float) -> None:
        """Обновить пороги в конфигурации мышечных кликов"""
        # Обновляем существующую конфигурацию
        self._muscle_click.config.left_threshold = left_threshold
        self._muscle_click.config.right_threshold = right_threshold
        self._muscle_click.config.hold_threshold = hold_threshold
        
        # Обновляем отображение порогов
        self.threshold_info_label.setText(
            f"Пороги: ЛКМ={left_threshold:.1f} мкВ, Зажатие={hold_threshold:.1f} мкВ, ПКМ={right_threshold:.1f} мкВ"
        )
        
        # Сохраняем пороги в код (для будущих запусков)
        self._save_thresholds_to_code(left_threshold, right_threshold, hold_threshold)
    
    def _save_thresholds_to_code(self, left_threshold: float, right_threshold: float, hold_threshold: float) -> None:
        """Сохранить пороги в код muscle_click.py"""
        try:
            import json
            
            # Создаем файл конфигурации порогов
            config_data = {
                "left_threshold": left_threshold,
                "right_threshold": right_threshold,
                "hold_threshold": hold_threshold,
                "timestamp": QtCore.QDateTime.currentDateTime().toString()
            }
            
            # Путь к файлу конфигурации
            config_path = os.path.join(os.path.dirname(__file__), '..', 'control', 'threshold_config.json')
            
            # Сохраняем конфигурацию
            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2, ensure_ascii=False)
                
            print(f"Пороги сохранены в {config_path}")
            
        except Exception as e:
            print(f"Ошибка сохранения порогов: {e}")

    # --- колбэки CallibriStream ---
    def _safe_mems_callback(self, stream: CallibriStream, data: Sequence[MEMSData]) -> None:
        try:
            self._on_mems(stream, data)
        except Exception as e:
            print(f"Ошибка в MEMS колбэке: {e}")
            # Продолжаем работу несмотря на ошибку
    
    def _safe_quat_callback(self, stream: CallibriStream, data: Sequence[QuaternionData]) -> None:
        try:
            self._on_quat(stream, data)
        except Exception as e:
            print(f"Ошибка в кватернион колбэке: {e}")
    
    def _safe_envelope_callback(self, stream: CallibriStream, data: Sequence[CallibriEnvelopeData]) -> None:
        try:
            self._on_envelope(stream, data)
        except Exception as e:
            print(f"Ошибка в envelope колбэке: {e}")
    
    def _safe_signal_callback(self, stream: CallibriStream, data: Sequence[CallibriSignalData]) -> None:
        try:
            self._on_signal(stream, data)
        except Exception as e:
            print(f"Ошибка в signal колбэке: {e}")
    
    def _on_mems(self, stream: CallibriStream, data: Sequence[MEMSData]) -> None:
        if not data:
            return
        try:
            m = data[-1]
            acc = m.Accelerometer
            gyr = m.Gyroscope
        except (AttributeError, IndexError) as e:
            return
        except Exception as e:
            print(f"Ошибка разбора MEMS данных: {e}")
            return

        try:
            self._mems_mouse.update_mems(data)
        except Exception as e:
            print(f"Ошибка обновления мыши: {e}")

        try:
            with self._lock:
                self._acc_x.append(float(acc.X))
                self._acc_y.append(float(acc.Y))
                self._acc_z.append(float(acc.Z))
                self._gyr_x.append(float(gyr.X))
                self._gyr_z.append(float(gyr.Z))
        except (ValueError, AttributeError) as e:
            print(f"Ошибка конвертации данных: {e}")
        except Exception as e:
            print(f"Ошибка сохранения данных: {e}")

    def _on_quat(self, stream: CallibriStream, data: Sequence[QuaternionData]) -> None:
        # Кватернионы сейчас не отображаем, но колбэк обязателен для CallibriStream.
        return

    def _on_envelope(self, stream: CallibriStream, data: Sequence[CallibriEnvelopeData]) -> None:
        if not data:
            return
        try:
            last = data[-1]
            v = float(last.Sample)
        except (AttributeError, IndexError, ValueError) as e:
            return
        except Exception as e:
            print(f"Ошибка разбора envelope: {e}")
            return
            
        try:
            with self._lock:
                self._emg_env.append(v)
                self._mems_mouse.update_emg(v)
        except Exception as e:
            print(f"Ошибка сохранения envelope: {e}")

    def _on_signal(self, stream: CallibriStream, data: Sequence[CallibriSignalData]) -> None:
        if not data:
            return

        try:
            last = data[-1]
            if not getattr(last, "Samples", None):
                return
            vals = [abs(float(s)) for s in last.Samples]
            if not vals:
                return
            vmax = max(vals)
        except (AttributeError, ValueError, TypeError) as e:
            return
        except Exception as e:
            print(f"Ошибка разбора signal: {e}")
            return

        try:
            self._muscle_click.update_from_signal(data)
        except Exception as e:
            print(f"Ошибка обновления кликов: {e}")

        try:
            with self._lock:
                self._emg_sig.append(vmax)
        except Exception as e:
            print(f"Ошибка сохранения signal: {e}")

    # --- обновление графиков ---
    def _update_plots(self) -> None:
        try:
            with self._lock:
                acc_x = list(self._acc_x)
                acc_y = list(self._acc_y)
                acc_z = list(self._acc_z)
                gyr_x = list(self._gyr_x)
                gyr_y = list(self._gyr_y)
                gyr_z = list(self._gyr_z)
                emg_env = list(self._emg_env)
                emg_sig = list(self._emg_sig)

            # Обновляем MEMS
            if acc_x:
                x = list(range(len(acc_x)))
                self.acc_x_curve.setData(x, acc_x)
                self.acc_y_curve.setData(x, acc_y)
                self.acc_z_curve.setData(x, acc_z)

            if gyr_x:
                x = list(range(len(gyr_x)))
                self.gyr_x_curve.setData(x, gyr_x)
                self.gyr_y_curve.setData(x, gyr_y)
                self.gyr_z_curve.setData(x, gyr_z)

            # Обновляем EMG
            if emg_env:
                x = list(range(len(emg_env)))
                self.env_curve.setData(x, emg_env)
            if emg_sig:
                x = list(range(len(emg_sig)))
                self.sig_curve.setData(x, emg_sig)
                
        except Exception as e:
            # Ошибка в обновлении графиков не должна crash'ить программу
            print(f"Ошибка обновления графиков: {e}")
            # Продолжаем работу таймера
            pass


def main() -> None:
    app = QtWidgets.QApplication(sys.argv)
    win = CallibriDashboard()
    win.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
