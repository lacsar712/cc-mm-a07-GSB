from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings
from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app.rules import classify


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg2://app:app@localhost:54391/methane"
    jwt_secret: str = "mine-methane-dev-secret"


settings = Settings()
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer(auto_error=False)
USERS = {
    "gasman": {"role": "writer", "password_hash": pwd.hash("gas123456")},
    "viewer": {"role": "reader", "password_hash": pwd.hash("view123456")},
}

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine)


class Base(DeclarativeBase):
    pass


class Reading(Base):
    __tablename__ = "readings"
    id: Mapped[int] = mapped_column(primary_key=True)
    site: Mapped[str] = mapped_column(String(80))
    ch4_pct: Mapped[float] = mapped_column(Float)
    level: Mapped[str] = mapped_column(String(20))
    note: Mapped[str] = mapped_column(String(200))
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Comparison(Base):
    """一次通风前后对照：钉定时把两笔班测的浓度与状态快照存下来。"""

    __tablename__ = "comparisons"
    id: Mapped[int] = mapped_column(primary_key=True)
    local_reading_id: Mapped[int] = mapped_column(ForeignKey("readings.id"))
    ref_reading_id: Mapped[int] = mapped_column(ForeignKey("readings.id"))
    local_site: Mapped[str] = mapped_column(String(80))
    ref_site: Mapped[str] = mapped_column(String(80))
    local_ch4: Mapped[float] = mapped_column(Float)
    ref_ch4: Mapped[float] = mapped_column(Float)
    local_level: Mapped[str] = mapped_column(String(20))
    ref_level: Mapped[str] = mapped_column(String(20))
    ch4_diff: Mapped[float] = mapped_column(Float)
    minutes: Mapped[int] = mapped_column(Integer)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class LoginIn(BaseModel):
    username: str
    password: str


class ReadingIn(BaseModel):
    site: str = Field(min_length=1, max_length=80)
    ch4_pct: float


class ReadingFixIn(BaseModel):
    ch4_pct: float = Field(ge=0)


class ComparisonIn(BaseModel):
    local_reading_id: int
    ref_reading_id: int
    minutes: int = Field(gt=0)


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> dict:
    if credentials is None:
        raise HTTPException(status_code=401, detail="未登录")
    try:
        payload = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=["HS256"])
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="无效令牌") from exc
    username = payload.get("sub")
    if username not in USERS:
        raise HTTPException(status_code=401, detail="无效令牌")
    return {"username": username, "role": payload.get("role")}


def require_writer(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "writer":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="仅瓦斯检查员可上报")
    return user


sockets: set[WebSocket] = set()
app = FastAPI(title="矿井瓦斯班测台")


@app.on_event("startup")
def startup():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if db.query(Reading).count() == 0:
            now = datetime.now(timezone.utc)
            for site, ch4 in (("东翼-12", 0.35), ("回风巷", 1.4)):
                level, note = classify(ch4)
                db.add(
                    Reading(
                        site=site,
                        ch4_pct=ch4,
                        level=level,
                        note=note,
                        created_by="gasman",
                        created_at=now,
                    )
                )
            db.commit()
    finally:
        db.close()


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "mine-methane-shift"}


@app.post("/api/auth/login")
def login(body: LoginIn):
    user = USERS.get(body.username.strip())
    if not user or not pwd.verify(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": body.username.strip(), "role": user["role"], "exp": exp},
        settings.jwt_secret,
        algorithm="HS256",
    )
    return {"access_token": token, "username": body.username.strip(), "role": user["role"]}


@app.get("/api/readings")
def list_readings(_user: dict = Depends(current_user)):
    db = SessionLocal()
    try:
        rows = db.query(Reading).order_by(Reading.id.desc()).all()
        return [
            {
                "id": r.id,
                "site": r.site,
                "ch4_pct": r.ch4_pct,
                "level": r.level,
                "note": r.note,
                "created_by": r.created_by,
            }
            for r in rows
        ]
    finally:
        db.close()


@app.post("/api/readings", status_code=201)
async def create_reading(body: ReadingIn, user: dict = Depends(require_writer)):
    level, note = classify(body.ch4_pct)
    db = SessionLocal()
    try:
        row = Reading(
            site=body.site.strip(),
            ch4_pct=body.ch4_pct,
            level=level,
            note=note,
            created_by=user["username"],
            created_at=datetime.now(timezone.utc),
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        payload = {"id": row.id, "site": row.site, "ch4_pct": row.ch4_pct, "level": row.level, "note": row.note}
    finally:
        db.close()
    dead = []
    for ws in list(sockets):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        sockets.discard(ws)
    return payload


@app.websocket("/ws/alerts")
async def alerts(ws: WebSocket):
    await ws.accept()
    sockets.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        sockets.discard(ws)


@app.patch("/api/readings/{reading_id}")
def fix_reading(reading_id: int, body: ReadingFixIn, user: dict = Depends(require_writer)):
    """检查员改正一笔已上报班测的浓度；状态随之重新判定。"""
    level, note = classify(body.ch4_pct)
    db = SessionLocal()
    try:
        row = db.get(Reading, reading_id)
        if row is None:
            raise HTTPException(status_code=404, detail="班测不存在")
        row.ch4_pct = body.ch4_pct
        row.level = level
        row.note = note
        db.commit()
        return {
            "id": row.id,
            "site": row.site,
            "ch4_pct": row.ch4_pct,
            "level": row.level,
            "note": row.note,
        }
    finally:
        db.close()


def serialize_comparison(db: Session, c: Comparison) -> dict:
    local = db.get(Reading, c.local_reading_id)
    ref = db.get(Reading, c.ref_reading_id)
    # 钉定时的差永远取快照；现值仅用于判断来源是否被改正。
    local_changed = local is not None and (
        local.ch4_pct != c.local_ch4 or local.level != c.local_level
    )
    ref_changed = ref is not None and (
        ref.ch4_pct != c.ref_ch4 or ref.level != c.ref_level
    )
    return {
        "id": c.id,
        "minutes": c.minutes,
        "ch4_diff": c.ch4_diff,
        "created_by": c.created_by,
        "created_at": c.created_at.isoformat(),
        "local": {
            "reading_id": c.local_reading_id,
            "site": c.local_site,
            "ch4_pct": c.local_ch4,
            "level": c.local_level,
            "present": local is not None,
            "changed": local_changed or local is None,
            "current_ch4_pct": None if local is None else local.ch4_pct,
            "current_level": None if local is None else local.level,
        },
        "ref": {
            "reading_id": c.ref_reading_id,
            "site": c.ref_site,
            "ch4_pct": c.ref_ch4,
            "level": c.ref_level,
            "present": ref is not None,
            "changed": ref_changed or ref is None,
            "current_ch4_pct": None if ref is None else ref.ch4_pct,
            "current_level": None if ref is None else ref.level,
        },
        "source_changed": local_changed or ref_changed or local is None or ref is None,
    }


@app.post("/api/comparisons", status_code=201)
def create_comparison(body: ComparisonIn, user: dict = Depends(require_writer)):
    if body.local_reading_id == body.ref_reading_id:
        raise HTTPException(status_code=400, detail="通风前后必须是两笔不同班测")
    db = SessionLocal()
    try:
        local = db.get(Reading, body.local_reading_id)
        ref = db.get(Reading, body.ref_reading_id)
        if local is None or ref is None:
            raise HTTPException(status_code=404, detail="参照班测不存在")
        # 差值在钉定时由服务端计算并冻结。
        diff = round(abs(local.ch4_pct - ref.ch4_pct), 4)
        row = Comparison(
            local_reading_id=local.id,
            ref_reading_id=ref.id,
            local_site=local.site,
            ref_site=ref.site,
            local_ch4=local.ch4_pct,
            ref_ch4=ref.ch4_pct,
            local_level=local.level,
            ref_level=ref.level,
            ch4_diff=diff,
            minutes=body.minutes,
            created_by=user["username"],
            created_at=datetime.now(timezone.utc),
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return serialize_comparison(db, row)
    finally:
        db.close()


@app.get("/api/comparisons")
def list_comparisons(_user: dict = Depends(current_user)):
    db = SessionLocal()
    try:
        rows = db.query(Comparison).order_by(Comparison.id.desc()).all()
        return [
            {
                "id": c.id,
                "local_site": c.local_site,
                "ref_site": c.ref_site,
                "ch4_diff": c.ch4_diff,
                "minutes": c.minutes,
                "source_changed": serialize_comparison(db, c)["source_changed"],
            }
            for c in rows
        ]
    finally:
        db.close()


@app.get("/api/comparisons/{comparison_id}")
def get_comparison(comparison_id: int, _user: dict = Depends(current_user)):
    db = SessionLocal()
    try:
        row = db.get(Comparison, comparison_id)
        if row is None:
            raise HTTPException(status_code=404, detail="对照不存在")
        return serialize_comparison(db, row)
    finally:
        db.close()
