"""
FastAPI Backend для EMG Data Collection
Python 3.12.2
"""

from fastapi import FastAPI, HTTPException, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from datetime import datetime, timedelta
import sqlite3
import hashlib
import secrets
import json
from typing import Optional
from contextlib import contextmanager

app = FastAPI(title="EMG Data Collection API", version="1.0.0")

# CORS настройки
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

security = HTTPBearer(auto_error=False)

DATABASE_PATH = "emg_database.db"

# ============ DATABASE ============
@contextmanager
def get_db():
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    with get_db() as conn:
        cursor = conn.cursor()
        
        # Таблица пользователей
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                name TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_admin INTEGER DEFAULT 0
            )
        """)
        
        # Таблица токенов
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token TEXT UNIQUE NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        
        # Таблица EMG данных
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS emg_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                session_id TEXT NOT NULL,
                accelerometer_x REAL,
                accelerometer_y REAL,
                accelerometer_z REAL,
                gyroscope_x REAL,
                gyroscope_y REAL,
                gyroscope_z REAL,
                emg_envelope REAL,
                emg_signal_max REAL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        
        # Создание админа по умолчанию (admin@admin.com / admin123)
        admin_hash = hashlib.sha256("admin123".encode()).hexdigest()
        cursor.execute("""
            INSERT OR IGNORE INTO users (email, password_hash, name, is_admin)
            VALUES ('admin@admin.com', ?, 'Administrator', 1)
        """, (admin_hash,))
        
        conn.commit()

# Инициализация БД при старте
init_db()

@app.get("/")
def root():
    return {
        "name": "EMG Data Collection API",
        "version": "1.0.0",
        "docs": "/docs",
        "health": "/api/health",
        "endpoints": {
            "auth": ["/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/auth/me"],
            "emg": ["/api/emg/data", "/api/emg/sessions"],
            "admin": ["/api/admin/users", "/api/admin/emg-data", "/api/admin/stats"]
        }
    }

# ============ MODELS ============
class UserRegister(BaseModel):
    email: EmailStr
    password: str
    name: str

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class UserResponse(BaseModel):
    id: int
    email: str
    name: str
    is_admin: bool

class TokenResponse(BaseModel):
    token: str
    user: UserResponse

class EMGDataInput(BaseModel):
    session_id: str
    accelerometer_x: float
    accelerometer_y: float
    accelerometer_z: float
    gyroscope_x: float
    gyroscope_y: float
    gyroscope_z: float
    emg_envelope: float
    emg_signal_max: float

# ============ AUTH HELPERS ============
def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def generate_token() -> str:
    return secrets.token_hex(32)

def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> Optional[dict]:
    if not credentials:
        return None
    
    token = credentials.credentials
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT u.id, u.email, u.name, u.is_admin 
            FROM users u
            JOIN tokens t ON u.id = t.user_id
            WHERE t.token = ? AND t.expires_at > datetime('now')
        """, (token,))
        row = cursor.fetchone()
        if row:
            return {"id": row["id"], "email": row["email"], "name": row["name"], "is_admin": bool(row["is_admin"])}
    return None

def require_auth(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    user = get_current_user(credentials)
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return user

def require_admin(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    user = require_auth(credentials)
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user

# ============ AUTH ENDPOINTS ============
@app.post("/api/auth/register", response_model=TokenResponse)
def register(data: UserRegister):
    if len(data.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    
    with get_db() as conn:
        cursor = conn.cursor()
        
        # Проверка существующего email
        cursor.execute("SELECT id FROM users WHERE email = ?", (data.email,))
        if cursor.fetchone():
            raise HTTPException(status_code=400, detail="Email already exists")
        
        # Создание пользователя
        password_hash = hash_password(data.password)
        cursor.execute(
            "INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)",
            (data.email, password_hash, data.name)
        )
        user_id = cursor.lastrowid
        
        # Создание токена
        token = generate_token()
        expires_at = datetime.now() + timedelta(days=30)
        cursor.execute(
            "INSERT INTO tokens (user_id, token, expires_at) VALUES (?, ?, ?)",
            (user_id, token, expires_at)
        )
        
        conn.commit()
        
        return TokenResponse(
            token=token,
            user=UserResponse(id=user_id, email=data.email, name=data.name, is_admin=False)
        )

@app.post("/api/auth/login", response_model=TokenResponse)
def login(data: UserLogin):
    with get_db() as conn:
        cursor = conn.cursor()
        
        password_hash = hash_password(data.password)
        cursor.execute(
            "SELECT id, email, name, is_admin FROM users WHERE email = ? AND password_hash = ?",
            (data.email, password_hash)
        )
        user = cursor.fetchone()
        
        if not user:
            raise HTTPException(status_code=401, detail="Invalid email or password")
        
        # Создание токена
        token = generate_token()
        expires_at = datetime.now() + timedelta(days=30)
        cursor.execute(
            "INSERT INTO tokens (user_id, token, expires_at) VALUES (?, ?, ?)",
            (user["id"], token, expires_at)
        )
        
        conn.commit()
        
        return TokenResponse(
            token=token,
            user=UserResponse(
                id=user["id"], 
                email=user["email"], 
                name=user["name"], 
                is_admin=bool(user["is_admin"])
            )
        )

@app.post("/api/auth/logout")
def logout(credentials: HTTPAuthorizationCredentials = Depends(security)):
    if credentials:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM tokens WHERE token = ?", (credentials.credentials,))
            conn.commit()
    return {"message": "Logged out"}

@app.get("/api/auth/me", response_model=UserResponse)
def get_me(user: dict = Depends(require_auth)):
    return UserResponse(**user)

# ============ EMG DATA ENDPOINTS ============
@app.post("/api/emg/data")
def save_emg_data(data: EMGDataInput, user: dict = Depends(require_auth)):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO emg_data (
                user_id, session_id, accelerometer_x, accelerometer_y, accelerometer_z,
                gyroscope_x, gyroscope_y, gyroscope_z, emg_envelope, emg_signal_max
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            user["id"], data.session_id,
            data.accelerometer_x, data.accelerometer_y, data.accelerometer_z,
            data.gyroscope_x, data.gyroscope_y, data.gyroscope_z,
            data.emg_envelope, data.emg_signal_max
        ))
        conn.commit()
    return {"message": "Data saved"}

@app.get("/api/emg/sessions")
def get_sessions(user: dict = Depends(require_auth)):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT DISTINCT session_id, MIN(timestamp) as started_at, COUNT(*) as data_points
            FROM emg_data WHERE user_id = ?
            GROUP BY session_id ORDER BY started_at DESC
        """, (user["id"],))
        return [dict(row) for row in cursor.fetchall()]

# ============ ADMIN ENDPOINTS ============
@app.get("/api/admin/users")
def admin_get_users(user: dict = Depends(require_admin)):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, email, name, is_admin, created_at FROM users ORDER BY created_at DESC")
        return [dict(row) for row in cursor.fetchall()]

@app.get("/api/admin/emg-data")
def admin_get_emg_data(user: dict = Depends(require_admin), limit: int = 100):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT e.*, u.email as user_email, u.name as user_name
            FROM emg_data e
            JOIN users u ON e.user_id = u.id
            ORDER BY e.timestamp DESC LIMIT ?
        """, (limit,))
        return [dict(row) for row in cursor.fetchall()]

@app.get("/api/admin/stats")
def admin_get_stats(user: dict = Depends(require_admin)):
    with get_db() as conn:
        cursor = conn.cursor()
        
        cursor.execute("SELECT COUNT(*) as count FROM users")
        users_count = cursor.fetchone()["count"]
        
        cursor.execute("SELECT COUNT(*) as count FROM emg_data")
        emg_count = cursor.fetchone()["count"]
        
        cursor.execute("SELECT COUNT(DISTINCT session_id) as count FROM emg_data")
        sessions_count = cursor.fetchone()["count"]
        
        return {
            "users": users_count,
            "emg_records": emg_count,
            "sessions": sessions_count
        }

@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(user_id: int, user: dict = Depends(require_admin)):
    if user_id == user["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
    return {"message": "User deleted"}

@app.get("/api/health")
def health_check():
    return {"status": "ok", "timestamp": datetime.now().isoformat()}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
