"use client"

import { useState, useEffect } from "react"
import { api } from "@/lib/api"
import { useRouter } from "next/navigation"
import { Users, Database, Activity, Trash2, RefreshCw, ArrowLeft, Shield } from "lucide-react"

interface UserData {
  id: number
  email: string
  name: string
  is_admin: number
  created_at: string
}

interface EMGRecord {
  id: number
  user_id: number
  session_id: string
  accelerometer_x: number
  accelerometer_y: number
  accelerometer_z: number
  gyroscope_x: number
  gyroscope_y: number
  gyroscope_z: number
  emg_envelope: number
  emg_signal_max: number
  timestamp: string
  user_email: string
  user_name: string
}

interface Stats {
  users: number
  emg_records: number
  sessions: number
}

export default function AdminPage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<"users" | "emg" | "stats">("stats")
  const [users, setUsers] = useState<UserData[]>([])
  const [emgData, setEmgData] = useState<EMGRecord[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    checkAdmin()
  }, [])

  const checkAdmin = async () => {
    try {
      const user = await api.getMe()
      if (!user.is_admin) {
        router.push("/")
        return
      }
      setIsAdmin(true)
      loadData()
    } catch {
      router.push("/")
    }
  }

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [statsData, usersData, emgRecords] = await Promise.all([
        api.getStats(),
        api.getUsers(),
        api.getEMGData(100),
      ])
      setStats(statsData)
      setUsers(usersData as unknown as UserData[])
      setEmgData(emgRecords as unknown as EMGRecord[])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteUser = async (userId: number) => {
    if (!confirm("Удалить этого пользователя?")) return
    try {
      await api.deleteUser(userId)
      loadData()
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete user")
    }
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800">
        <div className="text-white text-xl">Проверка доступа...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-white">
      {/* Header */}
      <header className="border-b border-white/10 bg-black/20 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push("/")}
              className="flex items-center gap-2 text-white/70 hover:text-white transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
              Назад
            </button>
            <div className="flex items-center gap-2">
              <Shield className="w-6 h-6 text-emerald-400" />
              <h1 className="text-xl font-bold">Админ-панель</h1>
            </div>
          </div>
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Обновить
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {error && (
          <div className="mb-6 p-4 bg-red-500/20 border border-red-500/50 rounded-lg text-red-200">{error}</div>
        )}

        {/* Tabs */}
        <div className="flex gap-2 mb-8">
          {[
            { id: "stats", label: "Статистика", icon: Activity },
            { id: "users", label: "Пользователи", icon: Users },
            { id: "emg", label: "EMG Данные", icon: Database },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id as typeof activeTab)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                activeTab === id
                  ? "bg-emerald-500 text-white"
                  : "bg-white/10 text-white/70 hover:bg-white/20 hover:text-white"
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>

        {/* Stats Tab */}
        {activeTab === "stats" && stats && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/10">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-blue-500/20 rounded-lg">
                  <Users className="w-8 h-8 text-blue-400" />
                </div>
                <div>
                  <p className="text-white/60 text-sm">Пользователей</p>
                  <p className="text-3xl font-bold">{stats.users}</p>
                </div>
              </div>
            </div>
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/10">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-emerald-500/20 rounded-lg">
                  <Database className="w-8 h-8 text-emerald-400" />
                </div>
                <div>
                  <p className="text-white/60 text-sm">EMG записей</p>
                  <p className="text-3xl font-bold">{stats.emg_records}</p>
                </div>
              </div>
            </div>
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/10">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-purple-500/20 rounded-lg">
                  <Activity className="w-8 h-8 text-purple-400" />
                </div>
                <div>
                  <p className="text-white/60 text-sm">Сессий записи</p>
                  <p className="text-3xl font-bold">{stats.sessions}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Users Tab */}
        {activeTab === "users" && (
          <div className="bg-white/10 backdrop-blur-sm rounded-xl border border-white/10 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-white/5">
                  <tr>
                    <th className="text-left px-4 py-3 text-white/60 font-medium">ID</th>
                    <th className="text-left px-4 py-3 text-white/60 font-medium">Email</th>
                    <th className="text-left px-4 py-3 text-white/60 font-medium">Имя</th>
                    <th className="text-left px-4 py-3 text-white/60 font-medium">Роль</th>
                    <th className="text-left px-4 py-3 text-white/60 font-medium">Создан</th>
                    <th className="text-left px-4 py-3 text-white/60 font-medium">Действия</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {users.map((user) => (
                    <tr key={user.id} className="hover:bg-white/5">
                      <td className="px-4 py-3">{user.id}</td>
                      <td className="px-4 py-3">{user.email}</td>
                      <td className="px-4 py-3">{user.name}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-1 rounded text-xs ${
                            user.is_admin ? "bg-emerald-500/20 text-emerald-300" : "bg-blue-500/20 text-blue-300"
                          }`}
                        >
                          {user.is_admin ? "Админ" : "Пользователь"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-white/60">{new Date(user.created_at).toLocaleString("ru-RU")}</td>
                      <td className="px-4 py-3">
                        {!user.is_admin && (
                          <button
                            onClick={() => handleDeleteUser(user.id)}
                            className="p-2 text-red-400 hover:bg-red-500/20 rounded-lg transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* EMG Data Tab */}
        {activeTab === "emg" && (
          <div className="bg-white/10 backdrop-blur-sm rounded-xl border border-white/10 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white/5">
                  <tr>
                    <th className="text-left px-3 py-3 text-white/60 font-medium">ID</th>
                    <th className="text-left px-3 py-3 text-white/60 font-medium">Пользователь</th>
                    <th className="text-left px-3 py-3 text-white/60 font-medium">Сессия</th>
                    <th className="text-left px-3 py-3 text-white/60 font-medium">Акселерометр</th>
                    <th className="text-left px-3 py-3 text-white/60 font-medium">Гироскоп</th>
                    <th className="text-left px-3 py-3 text-white/60 font-medium">EMG</th>
                    <th className="text-left px-3 py-3 text-white/60 font-medium">Время</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {emgData.map((record) => (
                    <tr key={record.id} className="hover:bg-white/5">
                      <td className="px-3 py-2">{record.id}</td>
                      <td className="px-3 py-2">
                        <div className="text-xs">
                          <div>{record.user_name}</div>
                          <div className="text-white/50">{record.user_email}</div>
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{record.session_id.slice(-8)}</td>
                      <td className="px-3 py-2 font-mono text-xs">
                        x:{record.accelerometer_x.toFixed(2)} y:{record.accelerometer_y.toFixed(2)} z:
                        {record.accelerometer_z.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        x:{record.gyroscope_x.toFixed(2)} y:{record.gyroscope_y.toFixed(2)} z:
                        {record.gyroscope_z.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        <span className="text-emerald-400">{record.emg_envelope.toFixed(1)}</span>/
                        <span className="text-blue-400">{record.emg_signal_max.toFixed(1)}</span>
                      </td>
                      <td className="px-3 py-2 text-white/60 text-xs">
                        {new Date(record.timestamp).toLocaleString("ru-RU")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {emgData.length === 0 && <div className="text-center py-8 text-white/50">Нет данных EMG</div>}
          </div>
        )}
      </main>
    </div>
  )
}
