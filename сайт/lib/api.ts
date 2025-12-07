/**
 * API клиент для FastAPI бэкенда
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"

interface User {
  id: number
  email: string
  name: string
  is_admin: boolean
}

interface AuthResponse {
  token: string
  user: User
}

interface EMGDataInput {
  session_id: string
  accelerometer_x: number
  accelerometer_y: number
  accelerometer_z: number
  gyroscope_x: number
  gyroscope_y: number
  gyroscope_z: number
  emg_envelope: number
  emg_signal_max: number
}

class ApiClient {
  private token: string | null = null

  constructor() {
    if (typeof window !== "undefined") {
      this.token = localStorage.getItem("auth_token")
    }
  }

  setToken(token: string | null) {
    this.token = token
    if (typeof window !== "undefined") {
      if (token) {
        localStorage.setItem("auth_token", token)
      } else {
        localStorage.removeItem("auth_token")
      }
    }
  }

  getToken() {
    return this.token
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    }

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`
    }

    const response = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      headers,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: "Request failed" }))
      throw new Error(error.detail || "Request failed")
    }

    return response.json()
  }

  // Auth endpoints
  async register(email: string, password: string, name: string): Promise<AuthResponse> {
    const data = await this.request<AuthResponse>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    })
    this.setToken(data.token)
    return data
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    const data = await this.request<AuthResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    })
    this.setToken(data.token)
    return data
  }

  async logout(): Promise<void> {
    try {
      await this.request("/api/auth/logout", { method: "POST" })
    } finally {
      this.setToken(null)
    }
  }

  async getMe(): Promise<User> {
    return this.request<User>("/api/auth/me")
  }

  // EMG endpoints
  async saveEMGData(data: EMGDataInput): Promise<void> {
    await this.request("/api/emg/data", {
      method: "POST",
      body: JSON.stringify(data),
    })
  }

  async getSessions(): Promise<Array<{ session_id: string; started_at: string; data_points: number }>> {
    return this.request("/api/emg/sessions")
  }

  // Admin endpoints
  async getUsers(): Promise<Array<User & { created_at: string }>> {
    return this.request("/api/admin/users")
  }

  async getEMGData(limit = 100): Promise<Array<Record<string, unknown>>> {
    return this.request(`/api/admin/emg-data?limit=${limit}`)
  }

  async getStats(): Promise<{ users: number; emg_records: number; sessions: number }> {
    return this.request("/api/admin/stats")
  }

  async deleteUser(userId: number): Promise<void> {
    await this.request(`/api/admin/users/${userId}`, { method: "DELETE" })
  }

  async healthCheck(): Promise<{ status: string; timestamp: string }> {
    return this.request("/api/health")
  }
}

export const api = new ApiClient()
export type { User, AuthResponse, EMGDataInput }
