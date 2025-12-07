"use client"

import type React from "react"

import { useState, useEffect, createContext, useContext, useRef, useCallback, type ReactNode } from "react"
import { MessageCircle, Send } from "lucide-react"
import { api } from "@/lib/api" // Alias User from api to ApiUser

// Mocking some components that might be from a UI library like shadcn/ui
// In a real scenario, these would be imported.
const Card = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={`rounded-lg shadow-md overflow-hidden bg-white ${className || ""}`}>{children}</div>
)
const CardHeader = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={`p-4 ${className || ""}`}>{children}</div>
)
const CardTitle = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <h3 className={`font-semibold text-lg ${className || ""}`}>{children}</h3>
)
const CardContent = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={`p-4 ${className || ""}`}>{children}</div>
)
const Input = ({
  value,
  onChange,
  placeholder,
  className,
  onKeyPress,
}: {
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
  className?: string
  onKeyPress?: (e: React.KeyboardEvent<HTMLInputElement>) => void
}) => (
  <input
    type="text"
    value={value}
    onChange={onChange}
    onKeyPress={onKeyPress}
    placeholder={placeholder}
    className={`border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none ${className || ""}`}
  />
)
const Button = ({
  onClick,
  children,
  disabled,
  className,
}: { onClick?: () => void; children: React.ReactNode; disabled?: boolean; className?: string }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`px-4 py-2 rounded-md font-medium transition-colors ${
      disabled ? "opacity-50 cursor-not-allowed" : ""
    } ${className || ""}`}
  >
    {children}
  </button>
)

// ============ TYPES ============
interface User {
  // Renamed from AppUser to User to match previous context
  id: string
  email: string
  name: string
  is_admin?: boolean
}

interface EMGData {
  accelerometer: { x: number; y: number; z: number }
  gyroscope: { x: number; y: number; z: number }
  emgEnvelope: number
  emgSignalMax: number
  timestamp: number
}

interface EMGSettings {
  sensitivity: number
  updateFrequency: number
  recordingDuration: number
  threshold: number
}

interface AuthContextType {
  user: User | null
  isLoading: boolean
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>
  register: (email: string, password: string, name: string) => Promise<{ success: boolean; error?: string }>
  logout: () => Promise<void>
}

interface EMGContextType {
  isConnected: boolean
  isRecording: boolean
  currentData: EMGData
  dataHistory: EMGData[]
  settings: EMGSettings
  setSettings: React.Dispatch<React.SetStateAction<EMGSettings>>
  connect: () => void
  disconnect: () => void
  startRecording: () => void
  stopRecording: () => void
  clearHistory: () => void
}

// ============ AUTH CONTEXT ============
const AuthContext = createContext<AuthContextType | null>(null)

function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider")
  }
  return context
}

function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    // Проверка существующего токена при загрузке
    const checkAuth = async () => {
      const token = api.getToken()
      if (token) {
        try {
          const userData = await api.getMe()
          setUser({
            id: userData.id.toString(),
            email: userData.email,
            name: userData.name,
            is_admin: userData.is_admin,
          })
        } catch {
          api.setToken(null)
        }
      }
      setIsLoading(false)
    }
    checkAuth()
  }, [])

  const register = async (email: string, password: string, name: string) => {
    try {
      const response = await api.register(email, password, name)
      setUser({
        id: response.user.id.toString(),
        email: response.user.email,
        name: response.user.name,
        is_admin: response.user.is_admin,
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Registration failed" }
    }
  }

  const login = async (email: string, password: string) => {
    try {
      const response = await api.login(email, password)
      setUser({
        id: response.user.id.toString(),
        email: response.user.email,
        name: response.user.name,
        is_admin: response.user.is_admin,
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Login failed" }
    }
  }

  const logout = async () => {
    await api.logout()
    setUser(null)
  }

  return <AuthContext.Provider value={{ user, isLoading, login, register, logout }}>{children}</AuthContext.Provider>
}

// ============ EMG CONTEXT ============
const EMGContext = createContext<EMGContextType | null>(null)

function useEMG() {
  const context = useContext(EMGContext)
  if (!context) {
    throw new Error("useEMG must be used within EMGProvider")
  }
  return context
}

function EMGProvider({ children }: { children: ReactNode }) {
  const [isConnected, setIsConnected] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [currentData, setCurrentData] = useState<EMGData>({
    accelerometer: { x: 0, y: 0, z: 0 },
    gyroscope: { x: 0, y: 0, z: 0 },
    emgEnvelope: 0,
    emgSignalMax: 0,
    timestamp: Date.now(),
  })
  const [dataHistory, setDataHistory] = useState<EMGData[]>([])
  const [settings, setSettings] = useState<EMGSettings>({
    sensitivity: 50,
    updateFrequency: 50,
    recordingDuration: 60,
    threshold: 30,
  })

  const intervalRef = useRef<NodeJS.Timeout | null>(null)
  const timeRef = useRef(0)
  const sessionIdRef = useRef<string>("")

  const generateSimulatedData = useCallback((): EMGData => {
    timeRef.current += 0.05
    const t = timeRef.current

    // Simulate natural arm at rest with occasional small movements
    const baseNoise = () => (Math.random() - 0.5) * 0.1
    const occasionalMovement = Math.sin(t * 0.3) * 0.2 + Math.sin(t * 0.7) * 0.1

    return {
      accelerometer: {
        x: occasionalMovement + baseNoise(),
        y: -9.8 + baseNoise() * 0.5,
        z: baseNoise(),
      },
      gyroscope: {
        x: Math.sin(t * 0.5) * 2 + baseNoise() * 5,
        y: Math.cos(t * 0.3) * 1.5 + baseNoise() * 5,
        z: baseNoise() * 3,
      },
      emgEnvelope: Math.abs(Math.sin(t * 2) * 30 + Math.random() * 20),
      emgSignalMax: Math.abs(Math.sin(t * 3) * 50 + Math.random() * 30),
      timestamp: Date.now(),
    }
  }, [])

  const connect = useCallback(() => {
    setIsConnected(true)
    sessionIdRef.current = `session_${Date.now()}`
    intervalRef.current = setInterval(() => {
      const newData = generateSimulatedData()
      setCurrentData(newData)
    }, settings.updateFrequency)
  }, [generateSimulatedData, settings.updateFrequency])

  const disconnect = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    setIsConnected(false)
    setIsRecording(false)
  }, [])

  const startRecording = useCallback(() => {
    setIsRecording(true)
    setDataHistory([])
  }, [])

  const stopRecording = useCallback(() => {
    setIsRecording(false)
  }, [])

  const clearHistory = useCallback(() => {
    setDataHistory([])
  }, [])

  useEffect(() => {
    if (isRecording && currentData) {
      setDataHistory((prev) => [...prev, currentData])

      // Отправляем данные на сервер
      if (sessionIdRef.current) {
        api
          .saveEMGData({
            session_id: sessionIdRef.current,
            accelerometer_x: currentData.accelerometer.x,
            accelerometer_y: currentData.accelerometer.y,
            accelerometer_z: currentData.accelerometer.z,
            gyroscope_x: currentData.gyroscope.x,
            gyroscope_y: currentData.gyroscope.y,
            gyroscope_z: currentData.gyroscope.z,
            emg_envelope: currentData.emgEnvelope,
            emg_signal_max: currentData.emgSignalMax,
          })
          .catch(console.error)
      }
    }
  }, [isRecording, currentData])

  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [])

  return (
    <EMGContext.Provider
      value={{
        isConnected,
        isRecording,
        currentData,
        dataHistory,
        settings,
        setSettings,
        connect,
        disconnect,
        startRecording,
        stopRecording,
        clearHistory,
      }}
    >
      {children}
    </EMGContext.Provider>
  )
}

// ============ NEURON BACKGROUND ============
function NeuronBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let animationId: number
    let neurons: Array<{
      x: number
      y: number
      vx: number
      vy: number
      radius: number
      pulsePhase: number
    }> = []

    const resize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }

    const createNeurons = () => {
      neurons = []
      const count = Math.floor((canvas.width * canvas.height) / 25000)
      for (let i = 0; i < count; i++) {
        neurons.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          vx: (Math.random() - 0.5) * 0.5,
          vy: (Math.random() - 0.5) * 0.5,
          radius: Math.random() * 3 + 2,
          pulsePhase: Math.random() * Math.PI * 2,
        })
      }
    }

    const animate = () => {
      ctx.fillStyle = "rgba(227, 242, 253, 0.1)"
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      neurons.forEach((neuron, i) => {
        neuron.x += neuron.vx
        neuron.y += neuron.vy
        neuron.pulsePhase += 0.02

        if (neuron.x < 0 || neuron.x > canvas.width) neuron.vx *= -1
        if (neuron.y < 0 || neuron.y > canvas.height) neuron.vy *= -1

        const pulse = Math.sin(neuron.pulsePhase) * 0.3 + 0.7
        const gradient = ctx.createRadialGradient(neuron.x, neuron.y, 0, neuron.x, neuron.y, neuron.radius * 2)
        gradient.addColorStop(0, `rgba(30, 136, 229, ${0.8 * pulse})`)
        gradient.addColorStop(1, "rgba(30, 136, 229, 0)")

        ctx.beginPath()
        ctx.arc(neuron.x, neuron.y, neuron.radius * pulse, 0, Math.PI * 2)
        ctx.fillStyle = gradient
        ctx.fill()

        neurons.slice(i + 1).forEach((other) => {
          const dx = other.x - neuron.x
          const dy = other.y - neuron.y
          const distance = Math.sqrt(dx * dx + dy * dy)

          if (distance < 150) {
            const opacity = (1 - distance / 150) * 0.3
            ctx.beginPath()
            ctx.moveTo(neuron.x, neuron.y)
            ctx.lineTo(other.x, other.y)
            ctx.strokeStyle = `rgba(100, 181, 246, ${opacity})`
            ctx.lineWidth = 0.5
            ctx.stroke()

            if (Math.random() < 0.002) {
              const signalPos = Math.random()
              const sx = neuron.x + dx * signalPos
              const sy = neuron.y + dy * signalPos
              ctx.beginPath()
              ctx.arc(sx, sy, 2, 0, Math.PI * 2)
              ctx.fillStyle = "rgba(30, 136, 229, 0.8)"
              ctx.fill()
            }
          }
        })
      })

      animationId = requestAnimationFrame(animate)
    }

    resize()
    createNeurons()
    animate()

    const handleResize = () => {
      resize()
      createNeurons()
    }

    window.addEventListener("resize", handleResize)

    return () => {
      cancelAnimationFrame(animationId)
      window.removeEventListener("resize", handleResize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ background: "linear-gradient(135deg, #E3F2FD 0%, #BBDEFB 50%, #E3F2FD 100%)" }}
    />
  )
}

function DetailedArmVisualization({ emgEnvelope, emgSignalMax }: { emgEnvelope: number; emgSignalMax: number }) {
  const muscleActivity = (emgEnvelope + emgSignalMax) / 250
  const muscleOpacity1 = 0.3 + muscleActivity * 0.5
  const muscleOpacity2 = 0.4 + muscleActivity * 0.5
  const bicepRx = 25 + muscleActivity * 8
  const bicepRy = 20 + muscleActivity * 5
  const waveY1 = 8 - muscleActivity * 4
  const waveY2 = 16 + muscleActivity * 4
  const signalOpacity = 0.3 + muscleActivity * 0.5

  return (
    <svg viewBox="0 0 200 400" className="w-full h-full max-h-[350px]">
      <defs>
        <linearGradient id="skinGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#E8BEAC" />
          <stop offset="50%" stopColor="#F5D0C5" />
          <stop offset="100%" stopColor="#E8BEAC" />
        </linearGradient>
        <linearGradient id="muscleGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#DC5050" stopOpacity={muscleOpacity1} />
          <stop offset="50%" stopColor="#C83C3C" stopOpacity={muscleOpacity2} />
          <stop offset="100%" stopColor="#DC5050" stopOpacity={muscleOpacity1} />
        </linearGradient>
        <filter id="armShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="2" dy="4" stdDeviation="3" floodOpacity="0.2" />
        </filter>
        <linearGradient id="sensorGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#1E88E5" />
          <stop offset="100%" stopColor="#1565C0" />
        </linearGradient>
      </defs>

      {/* Upper arm / shoulder area */}
      <ellipse cx="100" cy="30" rx="45" ry="25" fill="url(#skinGradient)" filter="url(#armShadow)" />

      {/* Upper arm */}
      <path d="M55 30 Q45 80 50 140 L55 140 Q60 80 60 40 Z" fill="url(#skinGradient)" filter="url(#armShadow)" />
      <path d="M145 30 Q155 80 150 140 L145 140 Q140 80 140 40 Z" fill="url(#skinGradient)" filter="url(#armShadow)" />

      {/* Main upper arm body */}
      <path
        d="M60 25 L60 140 Q100 150 140 140 L140 25 Q100 35 60 25"
        fill="url(#skinGradient)"
        filter="url(#armShadow)"
      />

      {/* Bicep muscle indication */}
      <ellipse cx="100" cy="85" rx={bicepRx} ry={bicepRy} fill="url(#muscleGradient)" opacity="0.6" />

      {/* Elbow */}
      <ellipse cx="100" cy="150" rx="32" ry="18" fill="url(#skinGradient)" filter="url(#armShadow)" />
      <ellipse cx="100" cy="150" rx="12" ry="8" fill="#D4A89A" opacity="0.5" />

      {/* Forearm */}
      <path
        d="M68 148 Q62 200 65 280 Q100 290 135 280 Q138 200 132 148 Q100 158 68 148"
        fill="url(#skinGradient)"
        filter="url(#armShadow)"
      />

      {/* Forearm muscle details */}
      <path d="M75 165 Q70 210 73 250" stroke="#D4A89A" strokeWidth="2" fill="none" opacity="0.4" />
      <path d="M125 165 Q130 210 127 250" stroke="#D4A89A" strokeWidth="2" fill="none" opacity="0.4" />

      {/* Wrist */}
      <ellipse cx="100" cy="285" rx="28" ry="12" fill="url(#skinGradient)" filter="url(#armShadow)" />

      {/* Hand palm */}
      <path
        d="M72 283 Q65 310 68 340 Q100 355 132 340 Q135 310 128 283 Q100 293 72 283"
        fill="url(#skinGradient)"
        filter="url(#armShadow)"
      />

      {/* Thumb */}
      <path
        d="M68 310 Q55 315 50 335 Q52 345 58 348 Q68 345 72 330 Q73 318 68 310"
        fill="url(#skinGradient)"
        filter="url(#armShadow)"
      />

      {/* Fingers */}
      <path
        d="M78 340 Q76 360 78 385 Q82 388 86 385 Q88 360 86 340"
        fill="url(#skinGradient)"
        filter="url(#armShadow)"
      />
      <path
        d="M92 342 Q90 365 92 395 Q96 398 100 395 Q102 365 100 342"
        fill="url(#skinGradient)"
        filter="url(#armShadow)"
      />
      <path
        d="M106 341 Q104 362 106 388 Q110 391 114 388 Q116 362 114 341"
        fill="url(#skinGradient)"
        filter="url(#armShadow)"
      />
      <path
        d="M120 338 Q118 355 120 375 Q124 378 128 375 Q130 355 128 338"
        fill="url(#skinGradient)"
        filter="url(#armShadow)"
      />

      {/* Finger joints */}
      <circle cx="82" cy="355" r="2" fill="#D4A89A" opacity="0.5" />
      <circle cx="82" cy="370" r="2" fill="#D4A89A" opacity="0.5" />
      <circle cx="96" cy="358" r="2" fill="#D4A89A" opacity="0.5" />
      <circle cx="96" cy="375" r="2" fill="#D4A89A" opacity="0.5" />
      <circle cx="110" cy="356" r="2" fill="#D4A89A" opacity="0.5" />
      <circle cx="110" cy="372" r="2" fill="#D4A89A" opacity="0.5" />
      <circle cx="124" cy="352" r="2" fill="#D4A89A" opacity="0.5" />
      <circle cx="124" cy="365" r="2" fill="#D4A89A" opacity="0.5" />

      {/* Knuckles */}
      <ellipse cx="82" cy="342" rx="5" ry="3" fill="#D4A89A" opacity="0.3" />
      <ellipse cx="96" cy="344" rx="5" ry="3" fill="#D4A89A" opacity="0.3" />
      <ellipse cx="110" cy="343" rx="5" ry="3" fill="#D4A89A" opacity="0.3" />
      <ellipse cx="124" cy="340" rx="5" ry="3" fill="#D4A89A" opacity="0.3" />

      {/* Calibri Sensor Device */}
      <g transform="translate(70, 190)">
        {/* Sensor strap */}
        <path d="M-5 -5 Q30 -15 65 -5 L65 35 Q30 45 -5 35 Z" fill="#2C3E50" stroke="#1E88E5" strokeWidth="2" />

        {/* Main sensor body */}
        <rect x="10" y="0" width="40" height="30" rx="5" fill="url(#sensorGradient)" />

        {/* Sensor screen */}
        <rect x="14" y="4" width="32" height="16" rx="2" fill="#0D47A1" />

        {/* Screen content - signal wave */}
        <path
          d={`M16 12 Q20 ${waveY1} 24 12 Q28 ${waveY2} 32 12 Q36 ${waveY1} 40 12`}
          stroke="#4FC3F7"
          strokeWidth="1.5"
          fill="none"
        />

        {/* LED indicators */}
        <circle cx="18" cy="24" r="2" fill={muscleActivity > 0.3 ? "#4CAF50" : "#1B5E20"}>
          <animate attributeName="opacity" values="1;0.5;1" dur="1s" repeatCount="indefinite" />
        </circle>
        <circle cx="26" cy="24" r="2" fill={muscleActivity > 0.5 ? "#FFC107" : "#5D4037"} />
        <circle cx="34" cy="24" r="2" fill={muscleActivity > 0.7 ? "#F44336" : "#3E2723"} />

        {/* Calibri logo text */}
        <text x="30" y="34" fontSize="6" fill="#fff" textAnchor="middle" fontWeight="bold">
          CALIBRI
        </text>

        {/* Electrode contacts */}
        <circle cx="5" cy="15" r="4" fill="#90A4AE" stroke="#607D8B" strokeWidth="1" />
        <circle cx="55" cy="15" r="4" fill="#90A4AE" stroke="#607D8B" strokeWidth="1" />
      </g>

      {/* Signal waves emanating from sensor */}
      <g opacity={signalOpacity}>
        <circle cx="100" cy="205" r="45" stroke="#1E88E5" strokeWidth="1" fill="none" opacity="0.3">
          <animate attributeName="r" values="45;55;45" dur="2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.3;0.1;0.3" dur="2s" repeatCount="indefinite" />
        </circle>
        <circle cx="100" cy="205" r="55" stroke="#1E88E5" strokeWidth="1" fill="none" opacity="0.2">
          <animate attributeName="r" values="55;65;55" dur="2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.2;0.05;0.2" dur="2s" repeatCount="indefinite" />
        </circle>
      </g>
    </svg>
  )
}

// ============ NAVIGATION ============
function Navigation({ currentPage, setCurrentPage }: { currentPage: string; setCurrentPage: (page: string) => void }) {
  const { isConnected } = useEMG()
  const { user, logout } = useAuth()

  const navItems = [
    { id: "home", label: "Главная" },
    { id: "connect", label: "Подключение" },
    { id: "monitor", label: "Мониторинг" },
    { id: "statistics", label: "Статистика" },
    { id: "settings", label: "Настройки" },
    { id: "support", label: "Поддержка" },
  ]

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-white/80 backdrop-blur-md border-b border-[#64B5F6]/30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-3">
            <img src="/images/neyrotekh.jpg" alt="Нейротех" className="h-10 object-contain rounded-lg shadow-sm" />
            {isConnected && (
              <span className="ml-2 px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full">Подключено</span>
            )}
          </div>

          <div className="hidden md:flex items-center gap-1">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setCurrentPage(item.id)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  currentPage === item.id
                    ? "bg-[#1E88E5] text-white"
                    : "text-gray-600 hover:bg-[#E3F2FD] hover:text-[#1E88E5]"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">{user?.name}</span>
            <button
              onClick={async () => await logout()} // Added async/await for logout
              className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
            >
              Выйти
            </button>
          </div>
        </div>
      </div>
    </nav>
  )
}

// ============ AUTH PAGE ============
function AuthPage() {
  const [isLogin, setIsLogin] = useState(true)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const { login, register } = useAuth()

  const handleSubmit = async (e: React.FormEvent) => {
    // Added async
    e.preventDefault()
    setError("")

    if (isLogin) {
      const result = await login(email, password) // Await login
      if (!result.success) {
        setError(result.error || "Login failed")
      }
    } else {
      if (password.length < 6) {
        setError("Пароль должен быть минимум 6 символов")
        return
      }
      const result = await register(email, password, name) // Await register
      if (!result.success) {
        setError(result.error || "Registration failed")
      }
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative">
      <NeuronBackground />
      <div className="w-full max-w-md relative z-10">
        <div className="bg-white/90 backdrop-blur-md rounded-2xl shadow-xl p-8 border border-[#64B5F6]/30">
          <div className="text-center mb-8">
            <div className="flex items-center justify-center mb-4">
              <img src="/images/neyrotekh.jpg" alt="Нейротех" className="h-14 object-contain rounded-xl shadow-md" />
            </div>
            <p className="text-gray-500">{isLogin ? "Войдите в аккаунт" : "Создайте аккаунт"}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {!isLogin && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Имя</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required={!isLogin}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1E88E5] focus:border-transparent outline-none"
                  placeholder="Ваше имя"
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1E88E5] focus:border-transparent outline-none"
                placeholder="example@mail.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Пароль</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1E88E5] focus:border-transparent outline-none"
                placeholder="Минимум 6 символов"
              />
            </div>

            {error && <div className="text-red-500 text-sm bg-red-50 p-3 rounded-lg">{error}</div>}

            <button
              type="submit"
              className="w-full py-3 bg-[#1E88E5] text-white rounded-lg font-medium hover:bg-[#1976D2] transition-colors"
            >
              {isLogin ? "Войти" : "Зарегистрироваться"}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button
              onClick={() => {
                setIsLogin(!isLogin)
                setError("")
              }}
              className="text-[#1E88E5] hover:underline text-sm"
            >
              {isLogin ? "Нет аккаунта? Зарегистрироваться" : "Уже есть аккаунт? Войти"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============ LANDING PAGE ============
function LandingPage({ setCurrentPage }: { setCurrentPage: (page: string) => void }) {
  const features = [
    {
      title: "Акселерометр",
      description: "Отслеживание ускорения и положения руки в пространстве",
      icon: "📐",
    },
    {
      title: "Гироскоп",
      description: "Измерение угловой скорости вращения конечности",
      icon: "🔄",
    },
    {
      title: "EMG Сигналы",
      description: "Мониторинг электромиографических данных мышц",
      icon: "⚡",
    },
  ]

  return (
    <div className="min-h-screen pt-20 relative">
      <NeuronBackground />
      <div className="relative z-10 max-w-6xl mx-auto px-4 py-12">
        <div className="text-center mb-16">
          <div className="flex items-center justify-center mb-8">
            <img src="/images/neyrotekh.jpg" alt="Нейротех" className="h-20 object-contain rounded-xl shadow-lg" />
          </div>
          <button
            onClick={() => setCurrentPage("connect")}
            className="mt-8 px-8 py-4 bg-[#1E88E5] text-white rounded-xl text-lg font-medium hover:bg-[#1976D2] transition-colors shadow-lg"
          >
            Начать работу
          </button>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {features.map((feature, index) => (
            <div
              key={index}
              className="bg-white/80 backdrop-blur-md rounded-xl p-6 border border-[#64B5F6]/30 shadow-lg"
            >
              <div className="text-4xl mb-4">{feature.icon}</div>
              <h3 className="text-xl font-semibold text-[#1E88E5] mb-2">{feature.title}</h3>
              <p className="text-gray-600">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ============ CONNECTION PAGE ============
function ConnectionPage({ setCurrentPage }: { setCurrentPage: (page: string) => void }) {
  const { isConnected, connect, disconnect } = useEMG()
  const [isConnecting, setIsConnecting] = useState(false)

  const handleConnect = async () => {
    setIsConnecting(true)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    connect()
    setIsConnecting(false)
  }

  return (
    <div className="min-h-screen pt-20 relative">
      <NeuronBackground />
      <div className="relative z-10 max-w-2xl mx-auto px-4 py-12">
        <div className="bg-white/90 backdrop-blur-md rounded-2xl p-8 border border-[#64B5F6]/30 shadow-xl">
          <h2 className="text-2xl font-bold text-[#1E88E5] mb-6 text-center">Подключение устройства</h2>

          <div className="flex flex-col items-center gap-6">
            <div
              className={`w-32 h-32 rounded-full flex items-center justify-center ${
                isConnected
                  ? "bg-green-100 text-green-600"
                  : isConnecting
                    ? "bg-yellow-100 text-yellow-600 animate-pulse"
                    : "bg-gray-100 text-gray-400"
              }`}
            >
              <svg className="w-16 h-16" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.71 7.71L12 2 6.29 7.71a1 1 0 000 1.41l4.3 4.3V22h2.82v-8.58l4.3-4.3a1 1 0 000-1.41zM12 5.83l3.17 3.17L12 12.17 8.83 9 12 5.83z" />
              </svg>
            </div>

            <p className="text-gray-600 text-center">
              {isConnected
                ? "Устройство подключено и готово к работе"
                : isConnecting
                  ? "Подключение к устройству..."
                  : "Нажмите кнопку для подключения к устройству Calibri"}
            </p>

            {!isConnected ? (
              <button
                onClick={handleConnect}
                disabled={isConnecting}
                className="px-8 py-3 bg-[#1E88E5] text-white rounded-lg font-medium hover:bg-[#1976D2] transition-colors disabled:opacity-50"
              >
                {isConnecting ? "Подключение..." : "Подключить"}
              </button>
            ) : (
              <div className="flex gap-4">
                <button
                  onClick={() => setCurrentPage("monitor")}
                  className="px-8 py-3 bg-[#1E88E5] text-white rounded-lg font-medium hover:bg-[#1976D2] transition-colors"
                >
                  Перейти к мониторингу
                </button>
                <button
                  onClick={disconnect}
                  className="px-8 py-3 bg-red-500 text-white rounded-lg font-medium hover:bg-red-600 transition-colors"
                >
                  Отключить
                </button>
              </div>
            )}
          </div>

          <div className="mt-8 p-4 bg-[#E3F2FD] rounded-lg">
            <h3 className="font-semibold text-[#1E88E5] mb-2">Датчик Calibri записывает:</h3>
            <ul className="text-sm text-gray-600 space-y-1">
              <li>• Акселерометр (X, Y, Z) - линейное ускорение</li>
              <li>• Гироскоп (X, Y, Z) - угловая скорость</li>
              <li>• EMG Envelope - огибающая ЭМГ сигнала</li>
              <li>• EMG Signal Max - максимальная амплитуда ЭМГ</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

function RealTimeChart({
  data,
  title,
  lines,
  unit,
  minValue,
  maxValue,
}: {
  data: EMGData[]
  title: string
  lines: Array<{ getValue: (d: EMGData) => number; color: string; label: string }>
  unit: string
  minValue: number
  maxValue: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const width = canvas.width
    const height = canvas.height
    const padding = 40

    ctx.fillStyle = "#fff"
    ctx.fillRect(0, 0, width, height)

    // Draw grid
    ctx.strokeStyle = "#e0e0e0"
    ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const y = padding + (i * (height - 2 * padding)) / 4
      ctx.beginPath()
      ctx.moveTo(padding, y)
      ctx.lineTo(width - padding, y)
      ctx.stroke()

      // Y-axis labels
      const value = maxValue - (i * (maxValue - minValue)) / 4
      ctx.fillStyle = "#999"
      ctx.font = "10px sans-serif"
      ctx.fillText(value.toFixed(0), 5, y + 4)
    }

    // Draw data lines
    if (data.length > 1) {
      const visibleData = data.slice(-100)

      lines.forEach((line) => {
        ctx.strokeStyle = line.color
        ctx.lineWidth = 1.5
        ctx.beginPath()

        visibleData.forEach((point, index) => {
          const x = padding + (index / (visibleData.length - 1)) * (width - 2 * padding)
          const value = line.getValue(point)
          const normalizedValue = (value - minValue) / (maxValue - minValue)
          const y = height - padding - normalizedValue * (height - 2 * padding)

          if (index === 0) {
            ctx.moveTo(x, y)
          } else {
            ctx.lineTo(x, y)
          }
        })
        ctx.stroke()
      })
    }

    // Draw title
    ctx.fillStyle = "#333"
    ctx.font = "bold 12px sans-serif"
    ctx.fillText(title, padding, 16)

    // Draw legend
    let legendX = width - padding - 10
    lines
      .slice()
      .reverse()
      .forEach((line) => {
        const currentValue = data.length > 0 ? line.getValue(data[data.length - 1]).toFixed(1) : "0"
        const text = `${line.label}: ${currentValue}${unit}`
        const textWidth = ctx.measureText(text).width
        legendX -= textWidth + 15

        ctx.fillStyle = line.color
        ctx.fillRect(legendX, 8, 10, 10)
        ctx.fillStyle = "#666"
        ctx.font = "10px sans-serif"
        ctx.fillText(text, legendX + 14, 16)
      })
  }, [data, title, lines, unit, minValue, maxValue])

  return <canvas ref={canvasRef} width={500} height={140} className="w-full rounded-lg border border-gray-200" />
}

// ============ MONITOR PAGE ============
function MonitorPage() {
  const { isConnected, isRecording, currentData, dataHistory, startRecording, stopRecording, clearHistory } = useEMG()

  if (!isConnected) {
    return (
      <div className="min-h-screen pt-20 relative">
        <NeuronBackground />
        <div className="relative z-10 max-w-2xl mx-auto px-4 py-12">
          <div className="bg-white/90 backdrop-blur-md rounded-2xl p-8 border border-[#64B5F6]/30 shadow-xl text-center">
            <h2 className="text-2xl font-bold text-[#1E88E5] mb-4">Устройство не подключено</h2>
            <p className="text-gray-600">Пожалуйста, подключите устройство Calibri для начала мониторинга</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen pt-20 relative">
      <NeuronBackground />
      <div className="relative z-10 max-w-7xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-[#1E88E5]">Мониторинг в реальном времени</h2>
          <div className="flex gap-3">
            <a
              href="/download" // Placeholder, actual download logic might be needed
              className="px-4 py-2 bg-[#1E88E5] text-white rounded-lg font-medium hover:bg-[#1976D2] transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              Скачать ПО
            </a>
            {!isRecording ? (
              <button
                onClick={startRecording}
                className="px-4 py-2 bg-green-500 text-white rounded-lg font-medium hover:bg-green-600 transition-colors flex items-center gap-2"
              >
                <span className="w-3 h-3 bg-white rounded-full"></span>
                Начать запись
              </button>
            ) : (
              <button
                onClick={stopRecording}
                className="px-4 py-2 bg-red-500 text-white rounded-lg font-medium hover:bg-red-600 transition-colors flex items-center gap-2"
              >
                <span className="w-3 h-3 bg-white rounded-sm"></span>
                Остановить
              </button>
            )}
            <button
              onClick={clearHistory}
              className="px-4 py-2 bg-gray-500 text-white rounded-lg font-medium hover:bg-gray-600 transition-colors"
            >
              Очистить
            </button>
          </div>
        </div>

        {isRecording && (
          <div className="mb-4 p-3 bg-red-100 border border-red-300 rounded-lg flex items-center gap-2">
            <span className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></span>
            <span className="text-red-700 font-medium">Идет запись... ({dataHistory.length} точек)</span>
          </div>
        )}

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left column - Arm visualization */}
          <div className="lg:col-span-1">
            <div className="bg-white/90 backdrop-blur-md rounded-xl p-6 border border-[#64B5F6]/30 shadow-lg">
              <h3 className="text-lg font-semibold text-[#1E88E5] mb-4 text-center">Визуализация датчика</h3>
              <DetailedArmVisualization emgEnvelope={currentData.emgEnvelope} emgSignalMax={currentData.emgSignalMax} />

              {/* Current values display */}
              <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                <div className="p-2 bg-[#E3F2FD] rounded-lg text-center">
                  <p className="text-gray-500 text-xs">EMG Envelope</p>
                  <p className="font-bold text-[#1E88E5]">{currentData.emgEnvelope.toFixed(1)}</p>
                </div>
                <div className="p-2 bg-[#FFF3E0] rounded-lg text-center">
                  <p className="text-gray-500 text-xs">EMG Max</p>
                  <p className="font-bold text-orange-600">{currentData.emgSignalMax.toFixed(1)}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Right column - 4 Charts */}
          <div className="lg:col-span-2 space-y-4">
            {/* Accelerometer Chart */}
            <div className="bg-white/90 backdrop-blur-md rounded-xl p-4 border border-[#64B5F6]/30 shadow-lg">
              <RealTimeChart
                data={dataHistory}
                title="Accelerometer"
                lines={[
                  { getValue: (d) => d.accelerometer.x, color: "#F44336", label: "X" },
                  { getValue: (d) => d.accelerometer.y, color: "#4CAF50", label: "Y" },
                  { getValue: (d) => d.accelerometer.z, color: "#2196F3", label: "Z" },
                ]}
                unit=" m/s²"
                minValue={-5}
                maxValue={15}
              />
            </div>

            {/* Gyroscope Chart */}
            <div className="bg-white/90 backdrop-blur-md rounded-xl p-4 border border-[#64B5F6]/30 shadow-lg">
              <RealTimeChart
                data={dataHistory}
                title="Gyroscope"
                lines={[
                  { getValue: (d) => d.gyroscope.x, color: "#E91E63", label: "X" },
                  { getValue: (d) => d.gyroscope.y, color: "#00BCD4", label: "Y" },
                  { getValue: (d) => d.gyroscope.z, color: "#FF9800", label: "Z" },
                ]}
                unit=" °/s"
                minValue={-80}
                maxValue={80}
              />
            </div>

            {/* EMG Envelope Chart */}
            <div className="bg-white/90 backdrop-blur-md rounded-xl p-4 border border-[#64B5F6]/30 shadow-lg">
              <RealTimeChart
                data={dataHistory}
                title="EMG Envelope"
                lines={[{ getValue: (d) => d.emgEnvelope, color: "#9C27B0", label: "Envelope" }]}
                unit=""
                minValue={0}
                maxValue={120}
              />
            </div>

            {/* EMG Signal Max Chart */}
            <div className="bg-white/90 backdrop-blur-md rounded-xl p-4 border border-[#64B5F6]/30 shadow-lg">
              <RealTimeChart
                data={dataHistory}
                title="EMG Signal Max"
                lines={[{ getValue: (d) => d.emgSignalMax, color: "#FF5722", label: "Signal Max" }]}
                unit=""
                minValue={0}
                maxValue={180}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function StatisticsPage() {
  const { dataHistory, isConnected } = useEMG()

  const stats = {
    avgAccelX:
      dataHistory.length > 0 ? dataHistory.reduce((sum, d) => sum + d.accelerometer.x, 0) / dataHistory.length : 0,
    avgAccelY:
      dataHistory.length > 0 ? dataHistory.reduce((sum, d) => sum + d.accelerometer.y, 0) / dataHistory.length : 0,
    avgAccelZ:
      dataHistory.length > 0 ? dataHistory.reduce((sum, d) => sum + d.accelerometer.z, 0) / dataHistory.length : 0,
    maxEmgEnvelope: dataHistory.length > 0 ? Math.max(...dataHistory.map((d) => d.emgEnvelope)) : 0,
    avgEmgEnvelope:
      dataHistory.length > 0 ? dataHistory.reduce((sum, d) => sum + d.emgEnvelope, 0) / dataHistory.length : 0,
    maxEmgSignal: dataHistory.length > 0 ? Math.max(...dataHistory.map((d) => d.emgSignalMax)) : 0,
    dataPoints: dataHistory.length,
  }

  return (
    <div className="min-h-screen pt-20 relative">
      <NeuronBackground />
      <div className="relative z-10 max-w-6xl mx-auto px-4 py-8">
        <h2 className="text-2xl font-bold text-[#1E88E5] mb-6">Статистика</h2>

        <div className="grid md:grid-cols-4 gap-4 mb-8">
          <div className="bg-white/90 backdrop-blur-md rounded-xl p-6 border border-[#64B5F6]/30 shadow-lg">
            <p className="text-sm text-gray-600">Средн. Accel X</p>
            <p className="text-2xl font-bold text-[#F44336]">{stats.avgAccelX.toFixed(2)} m/s²</p>
          </div>
          <div className="bg-white/90 backdrop-blur-md rounded-xl p-6 border border-[#64B5F6]/30 shadow-lg">
            <p className="text-sm text-gray-600">Средн. Accel Y</p>
            <p className="text-2xl font-bold text-[#4CAF50]">{stats.avgAccelY.toFixed(2)} m/s²</p>
          </div>
          <div className="bg-white/90 backdrop-blur-md rounded-xl p-6 border border-[#64B5F6]/30 shadow-lg">
            <p className="text-sm text-gray-600">Средн. Accel Z</p>
            <p className="text-2xl font-bold text-[#2196F3]">{stats.avgAccelZ.toFixed(2)} m/s²</p>
          </div>
          <div className="bg-white/90 backdrop-blur-md rounded-xl p-6 border border-[#64B5F6]/30 shadow-lg">
            <p className="text-sm text-gray-600">Точек данных</p>
            <p className="text-2xl font-bold text-gray-700">{stats.dataPoints}</p>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          <div className="bg-white/90 backdrop-blur-md rounded-xl p-6 border border-[#64B5F6]/30 shadow-lg">
            <p className="text-sm text-gray-600">Макс. EMG Envelope</p>
            <p className="text-3xl font-bold text-[#9C27B0]">{stats.maxEmgEnvelope.toFixed(1)}</p>
          </div>
          <div className="bg-white/90 backdrop-blur-md rounded-xl p-6 border border-[#64B5F6]/30 shadow-lg">
            <p className="text-sm text-gray-600">Средн. EMG Envelope</p>
            <p className="text-3xl font-bold text-[#9C27B0]">{stats.avgEmgEnvelope.toFixed(1)}</p>
          </div>
          <div className="bg-white/90 backdrop-blur-md rounded-xl p-6 border border-[#64B5F6]/30 shadow-lg">
            <p className="text-sm text-gray-600">Макс. EMG Signal</p>
            <p className="text-3xl font-bold text-[#FF5722]">{stats.maxEmgSignal.toFixed(1)}</p>
          </div>
        </div>

        {!isConnected && (
          <div className="mt-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-700">
            Подключите устройство для сбора данных статистики
          </div>
        )}
      </div>
    </div>
  )
}

// ============ SETTINGS PAGE ============
function SettingsPage() {
  const { settings, setSettings } = useEMG()

  return (
    <div className="min-h-screen pt-20 relative">
      <NeuronBackground />
      <div className="relative z-10 max-w-2xl mx-auto px-4 py-8">
        <h2 className="text-2xl font-bold text-[#1E88E5] mb-6">Настройки</h2>

        <div className="bg-white/90 backdrop-blur-md rounded-xl p-6 border border-[#64B5F6]/30 shadow-lg space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Чувствительность: {settings.sensitivity}%
            </label>
            <input
              type="range"
              min="10"
              max="100"
              value={settings.sensitivity}
              onChange={(e) => setSettings({ ...settings, sensitivity: Number(e.target.value) })}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Частота обновления: {settings.updateFrequency}мс
            </label>
            <input
              type="range"
              min="20"
              max="200"
              step="10"
              value={settings.updateFrequency}
              onChange={(e) => setSettings({ ...settings, updateFrequency: Number(e.target.value) })}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Порог срабатывания: {settings.threshold}%
            </label>
            <input
              type="range"
              min="10"
              max="90"
              value={settings.threshold}
              onChange={(e) => setSettings({ ...settings, threshold: Number(e.target.value) })}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Длительность записи: {settings.recordingDuration}с
            </label>
            <input
              type="range"
              min="10"
              max="300"
              step="10"
              value={settings.recordingDuration}
              onChange={(e) => setSettings({ ...settings, recordingDuration: Number(e.target.value) })}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ============ SUPPORT PAGE ============
interface ChatMessage {
  id: number
  text: string
  isUser: boolean
  timestamp: Date
}

function SupportPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      text: "Здравствуйте! Я виртуальный помощник Нейротех. Задайте мне вопрос о программе, и я постараюсь помочь.",
      isUser: false,
      timestamp: new Date(),
    },
  ])
  const [inputText, setInputText] = useState("")
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const getBotResponse = (question: string): string => {
    const lowerQuestion = question.toLowerCase()

    if (lowerQuestion.includes("данные") || lowerQuestion.includes("показ") || lowerQuestion.includes("график")) {
      return `В программе отображаются следующие данные с датчика Calibri:

📊 **Accelerometer (Акселерометр)** — измеряет ускорение руки по трем осям (X, Y, Z) в м/с². Позволяет отслеживать движения и положение конечности в пространстве.

📊 **Gyroscope (Гироскоп)** — измеряет угловую скорость вращения руки по трем осям в °/с. Помогает определить ориентацию и повороты конечности.

📊 **EMG Envelope** — огибающая электромиографического сигнала в микровольтах (μV). Показывает общий уровень мышечной активности.

📊 **EMG Signal Max** — максимальные значения EMG сигнала. Позволяет отслеживать пиковую мышечную активность.

Все данные записываются в реальном времени и могут быть сохранены для дальнейшего анализа.`
    }

    if (
      lowerQuestion.includes("можно") ||
      lowerQuestion.includes("функци") ||
      lowerQuestion.includes("возможност") ||
      lowerQuestion.includes("делать") ||
      lowerQuestion.includes("сделать")
    ) {
      return `В программе доступны следующие функции:

✅ **Подключение устройства** — подключение датчика Calibri по Bluetooth для сбора данных.

✅ **Мониторинг в реальном времени** — просмотр данных акселерометра, гироскопа и EMG сигналов на графиках.

✅ **Запись данных** — начало и остановка записи сессий для последующего анализа.

✅ **Статистика** — просмотр истории записей, средних показателей и статистики по сессиям.

✅ **Настройки** — конфигурация частоты обновления, чувствительности датчиков и других параметров.

✅ **Экспорт данных** — сохранение записанных данных для использования в других программах.

💡 Также вы можете скачать десктопное ПО на нашем сайте для расширенных возможностей анализа!`
    }

    if (
      lowerQuestion.includes("скачать") ||
      lowerQuestion.includes("по") ||
      lowerQuestion.includes("программ") ||
      lowerQuestion.includes("установ") ||
      lowerQuestion.includes("download")
    ) {
      return `Вы можете скачать десктопное программное обеспечение на нашем сайте:

🖥️ **Для Windows** — полнофункциональная версия с расширенными возможностями анализа данных.

🍎 **Для macOS** — адаптированная версия для компьютеров Apple.

Для скачивания нажмите кнопку **"Скачать ПО"** на странице мониторинга или перейдите в раздел загрузок на официальном сайте Нейротех.

Десктопная версия включает:
• Расширенный анализ EMG сигналов
• Экспорт в различные форматы (CSV, JSON, XLSX)
• Интеграция с медицинскими системами
• Оффлайн режим работы`
    }

    if (
      lowerQuestion.includes("датчик") ||
      lowerQuestion.includes("calibri") ||
      lowerQuestion.includes("калибри") ||
      lowerQuestion.includes("устройств")
    ) {
      return `**Датчик Calibri** — это компактное устройство для сбора биометрических данных:

🔹 **Акселерометр** — 3-осевой, диапазон ±16g
🔹 **Гироскоп** — 3-осевой, диапазон ±2000°/с
🔹 **EMG сенсор** — высокочувствительный электромиографический датчик

Датчик крепится на предплечье и передает данные по Bluetooth в реальном времени. Используется для:
• Медицинской диагностики
• Реабилитации после травм
• Научных исследований
• Спортивного мониторинга`
    }

    if (lowerQuestion.includes("привет") || lowerQuestion.includes("здравствуй") || lowerQuestion.includes("добрый")) {
      return "Здравствуйте! Рад вас видеть. Чем могу помочь? Вы можете спросить меня о данных, которые показывает программа, о её функциях или о том, где скачать ПО."
    }

    if (lowerQuestion.includes("спасибо") || lowerQuestion.includes("благодар")) {
      return "Пожалуйста! Если у вас возникнут ещё вопросы, я всегда готов помочь. Удачной работы с программой!"
    }

    return `Я могу ответить на вопросы о:

• **Какие данные показаны** — информация о графиках и измерениях
• **Что можно сделать** — функции и возможности программы
• **Где скачать ПО** — информация о десктопной версии
• **Датчик Calibri** — характеристики устройства

Попробуйте задать один из этих вопросов!`
  }

  const handleSendMessage = () => {
    if (!inputText.trim()) return

    const userMessage: ChatMessage = {
      id: Date.now(),
      text: inputText,
      isUser: true,
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMessage])
    setInputText("")

    setTimeout(() => {
      const botResponse: ChatMessage = {
        id: Date.now() + 1,
        text: getBotResponse(inputText),
        isUser: false,
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, botResponse])
    }, 500)
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#E3F2FD] via-white to-[#BBDEFB] pt-20 pb-8 px-4">
      <div className="max-w-3xl mx-auto">
        <Card className="border-[#64B5F6]/30 shadow-xl">
          <CardHeader className="border-b border-[#64B5F6]/20 bg-gradient-to-r from-[#1E88E5] to-[#1976D2]">
            <CardTitle className="flex items-center gap-3 text-white">
              <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center">
                <MessageCircle className="w-5 h-5" />
              </div>
              <div>
                <span className="block">Поддержка</span>
                <span className="text-xs font-normal text-white/70">Виртуальный помощник Нейротех</span>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="h-[500px] overflow-y-auto p-4 space-y-4 bg-gray-50/50">
              {messages.map((message) => (
                <div key={message.id} className={`flex ${message.isUser ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                      message.isUser
                        ? "bg-[#1E88E5] text-white rounded-br-md"
                        : "bg-white border border-[#64B5F6]/30 text-gray-800 rounded-bl-md shadow-sm"
                    }`}
                  >
                    <div className="whitespace-pre-line text-sm">{message.text}</div>
                    <div className={`text-xs mt-1 ${message.isUser ? "text-white/70" : "text-gray-400"}`}>
                      {formatTime(message.timestamp)}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="p-4 border-t border-[#64B5F6]/20 bg-white">
              <div className="flex gap-2">
                <Input
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Введите ваш вопрос..."
                  className="flex-1 border-[#64B5F6]/30 focus:border-[#1E88E5] focus:ring-[#1E88E5]/20"
                />
                <Button
                  onClick={handleSendMessage}
                  disabled={!inputText.trim()}
                  className="bg-[#1E88E5] hover:bg-[#1976D2] text-white px-4"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                <button
                  onClick={() => setInputText("Какие данные показаны в программе?")}
                  className="text-xs px-3 py-1.5 bg-[#E3F2FD] text-[#1E88E5] rounded-full hover:bg-[#BBDEFB] transition-colors"
                >
                  Какие данные показаны?
                </button>
                <button
                  onClick={() => setInputText("Что можно сделать в программе?")}
                  className="text-xs px-3 py-1.5 bg-[#E3F2FD] text-[#1E88E5] rounded-full hover:bg-[#BBDEFB] transition-colors"
                >
                  Функции программы
                </button>
                <button
                  onClick={() => setInputText("Где скачать ПО?")}
                  className="text-xs px-3 py-1.5 bg-[#E3F2FD] text-[#1E88E5] rounded-full hover:bg-[#BBDEFB] transition-colors"
                >
                  Скачать ПО
                </button>
                <button
                  onClick={() => setInputText("Расскажи про датчик Calibri")}
                  className="text-xs px-3 py-1.5 bg-[#E3F2FD] text-[#1E88E5] rounded-full hover:bg-[#BBDEFB] transition-colors"
                >
                  О датчике
                </button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ============ MAIN APP ============
function MainApp() {
  const [currentPage, setCurrentPage] = useState("home")

  const renderPage = () => {
    switch (currentPage) {
      case "home":
        return <LandingPage setCurrentPage={setCurrentPage} />
      case "connect":
        return <ConnectionPage setCurrentPage={setCurrentPage} />
      case "monitor":
        return <MonitorPage />
      case "statistics":
        return <StatisticsPage />
      case "settings":
        return <SettingsPage />
      case "support":
        return <SupportPage />
      default:
        return <LandingPage setCurrentPage={setCurrentPage} />
    }
  }

  return (
    <EMGProvider>
      <Navigation currentPage={currentPage} setCurrentPage={setCurrentPage} />
      {renderPage()}
    </EMGProvider>
  )
}

// ============ ROOT COMPONENT ============
export default function Home() {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#E3F2FD]">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-[#1E88E5] border-t-transparent"></div>
      </div>
    )
  }

  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}

function AppContent() {
  const { user, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#E3F2FD]">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-[#1E88E5] border-t-transparent"></div>
      </div>
    )
  }

  if (!user) {
    return <AuthPage />
  }

  return <MainApp />
}
