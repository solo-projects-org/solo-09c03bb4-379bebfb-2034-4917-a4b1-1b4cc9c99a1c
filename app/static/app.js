/* 林道巡护采集页逻辑：离线保存（IndexedDB）+ 回网补传（确认后才删除）
 *
 * 多标签页一致性：
 * - 同一浏览器可开多个采集页，它们共享同一个 IndexedDB 待传队列。
 * - 任一页对队列的提交（新增 / 确认后删除）都会通过 BroadcastChannel
 *   （不支持时回退到 localStorage storage 事件）通知其余各页自动重读重渲染，
 *   无需手动刷新。
 * - 后台挂起的页面被切回时（visibilitychange / pageshow / focus）也会重读队列。
 * - 渲染只重建“待传记录”列表与总数，绝不触碰正在填写的表单。
 */
"use strict";

/* ---------- Service Worker 注册（首次在线打开后，断网也能加载本页） ---------- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js")   // 根路径脚本，默认作用域 "/"
    .catch(err => console.error("SW 注册失败:", err));
}

/* ---------- IndexedDB：待传记录仓库 ---------- */
const DB_NAME = "forest-patrol";
const STORE = "pending";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "uuid" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbAdd(rec) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function idbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(uuid) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(uuid);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- 跨标签页队列变动通知 ----------
 * 只传递“队列已变动”的信号与变动类型，不传记录本身；
 * 收到信号的页面统一回到 IndexedDB 重读全量队列，以本机已提交的数据为准，
 * 因此交错保存/补传时不会漏掉新记录，也不会让已删除的记录重新出现。
 */
const QUEUE_CHANNEL = "forest-patrol-queue";
const queueChannel = (() => {
  if (typeof BroadcastChannel === "function") {
    try {
      return new BroadcastChannel(QUEUE_CHANNEL);
    } catch (e) {
      console.warn("BroadcastChannel 不可用，改用 storage 事件:", e);
    }
  }
  return null;
})();

function notifyQueueChanged(type, uuid) {
  const payload = { type, uuid: uuid || null, at: Date.now() };
  if (queueChannel) {
    // postMessage 只送达其他标签页，本页由调用处自行安排渲染
    queueChannel.postMessage(payload);
    return;
  }
  // 兜底：localStorage 的 storage 事件只在“其他”同源页面触发
  try {
    localStorage.setItem(
      QUEUE_CHANNEL,
      JSON.stringify(payload)
    );
  } catch (e) {
    console.warn("队列变动通知写入失败:", e);
  }
}

if (queueChannel) {
  queueChannel.addEventListener("message", ev => {
    if (ev.data && ev.data.type) scheduleRender("queue:" + ev.data.type);
  });
}
window.addEventListener("storage", ev => {
  if (ev.key === QUEUE_CHANNEL && ev.newValue) {
    scheduleRender("queue:storage");
  }
});

/* ---------- 页面元素 ---------- */
const $ = id => document.getElementById(id);
const latInput = $("lat"), lngInput = $("lng"), noteInput = $("note");
const photoInput = $("photo"), preview = $("preview");
const pendingList = $("pendingList"), pendingCount = $("pendingCount");
const syncStatus = $("syncStatus"), netStatus = $("netStatus");

/* ---------- 渲染待传列表（只读 IndexedDB，只重建列表，绝不修改表单） ----------
 * - renderGen 为每次渲染的序号：过期渲染的结果直接丢弃，
 *   交错保存/补传时后提交的全量快照不会被先发起的旧快照覆盖。
 * - renderTimer 合并短时间内的多次变动通知（如逐笔补传成功），避免无谓重绘。
 */
let renderGen = 0;
let renderTimer = 0;

function scheduleRender(_reason) {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = 0;
    renderPending();
  }, 50);
}

async function renderPending() {
  const gen = ++renderGen;
  let items;
  try {
    items = await idbAll();
  } catch (e) {
    console.error("重读待传队列失败:", e);
    return;
  }
  // 读取期间又发起了更新的渲染：本次结果作废，以最新一次为准
  if (gen !== renderGen) return;

  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  pendingCount.textContent = items.length;

  // 回收上一轮创建的对象 URL，避免照片 Blob 引用泄漏
  for (const url of pendingList.dataset.objectUrls
    ? JSON.parse(pendingList.dataset.objectUrls) : []) {
    URL.revokeObjectURL(url);
  }
  const objectUrls = [];

  pendingList.textContent = "";   // 只清空待传列表，表单元素不受影响
  for (const it of items) {
    const li = document.createElement("li");
    li.className = "pending-item";
    const img = document.createElement("img");
    const url = URL.createObjectURL(it.photo);
    objectUrls.push(url);
    img.src = url;
    img.alt = "待传照片";
    img.className = "thumb";
    const info = document.createElement("div");
    info.textContent = "";
    const strong = document.createElement("strong");
    strong.textContent = `${it.lat.toFixed(6)}, ${it.lng.toFixed(6)}`;
    const time = document.createElement("small");
    time.textContent = it.createdAt.slice(0, 19).replace("T", " ");
    info.append(strong, document.createElement("br"), time);
    if (it.note) {
      const note = document.createElement("br");
      const noteText = document.createElement("span");
      noteText.textContent = it.note;   // textContent 天然转义，防注入
      info.append(note, noteText);
    }
    li.append(img, info);
    pendingList.appendChild(li);
  }
  pendingList.dataset.objectUrls = JSON.stringify(objectUrls);
}

/* ---------- 切回（从后台挂起恢复）页面时自动重读队列 ---------- */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleRender("visibility");
});
window.addEventListener("pageshow", () => scheduleRender("pageshow"));
window.addEventListener("focus", () => scheduleRender("focus"));

/* ---------- 网络状态提示 ---------- */
function refreshNetStatus() {
  if (navigator.onLine) {
    netStatus.textContent = "🟢 在线：可补传待传记录";
    netStatus.className = "net-status online";
  } else {
    netStatus.textContent = "🔴 离线：可正常填写保存，记录暂存本机";
    netStatus.className = "net-status offline";
  }
}
window.addEventListener("online", refreshNetStatus);
window.addEventListener("offline", refreshNetStatus);
refreshNetStatus();

/* ---------- 照片预览 ---------- */
function showPreview(blob) {
  preview.src = URL.createObjectURL(blob);
  preview.hidden = false;
}
photoInput.addEventListener("change", () => {
  if (photoInput.files[0]) showPreview(photoInput.files[0]);
});

/* 使用随附样例照片（样例已被 Service Worker 缓存，离线也能取到） */
$("sampleBtn").addEventListener("click", async () => {
  try {
    const resp = await fetch("/static/sample-photo.png");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const blob = await resp.blob();
    const file = new File([blob], "sample-photo.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    photoInput.files = dt.files;
    showPreview(blob);
  } catch (e) {
    alert("样例照片加载失败：" + e.message);
  }
});

/* ---------- 定位 ---------- */
$("geoBtn").addEventListener("click", () => {
  if (!navigator.geolocation) return alert("此浏览器不支持定位");
  navigator.geolocation.getCurrentPosition(
    pos => {
      latInput.value = pos.coords.latitude.toFixed(6);
      lngInput.value = pos.coords.longitude.toFixed(6);
    },
    err => alert("定位失败：" + err.message),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

/* ---------- 保存到待传（离线可用） ---------- */
$("collectForm").addEventListener("submit", async () => {
  const lat = parseFloat(latInput.value);
  const lng = parseFloat(lngInput.value);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return alert("请填写经纬度");
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
    return alert("经纬度超出范围");
  const file = photoInput.files[0];
  if (!file) return alert("请选择或拍摄现场照片");

  const rec = {
    uuid: crypto.randomUUID(),          // 幂等键：重传同一笔只入库一次
    lat, lng,
    note: noteInput.value.trim(),
    createdAt: new Date().toISOString(),
    photo: file,                        // File/Blob 可直接存入 IndexedDB
    photoName: file.name || "photo.jpg",
  };
  await idbAdd(rec);                    // 先提交到本机队列
  notifyQueueChanged("add", rec.uuid); // 再通知其他标签页：有新待传

  latInput.value = lngInput.value = noteInput.value = "";
  photoInput.value = "";
  preview.hidden = true;
  scheduleRender("local-add");
});

/* ---------- 补传：收到服务器确认才移出待传 ---------- */
let syncing = false;
$("syncBtn").addEventListener("click", async () => {
  if (syncing) return;                   // 防止重复点击并发补传
  const items = await idbAll();
  if (!items.length) {
    syncStatus.textContent = "没有待传记录。";
    return;
  }
  syncing = true;
  syncStatus.textContent = "补传中…";
  let ok = 0, dup = 0, fail = 0;

  for (const it of items) {
    const fd = new FormData();
    fd.append("uuid", it.uuid);
    fd.append("lat", it.lat);
    fd.append("lng", it.lng);
    fd.append("note", it.note || "");
    fd.append("created_at", it.createdAt);
    fd.append("photo", it.photo, it.photoName || it.uuid + ".jpg");

    try {
      const resp = await fetch("/api/records", { method: "POST", body: fd });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "服务器拒绝");
      // 关键：只有拿到服务器确认后才删除本地待传记录；
      // 若确认在途中丢失，记录仍在本地，重传时服务器按 uuid 去重。
      await idbDelete(it.uuid);
      // 删除已提交到本机队列后再通知各页，其他页面只会看到“已移除”的事实，
      // 已移除的记录不会因任何后续通知重新出现。
      notifyQueueChanged("delete", it.uuid);
      scheduleRender("local-delete");
      data.duplicate ? dup++ : ok++;
    } catch (e) {
      console.warn("补传失败，保留待传:", it.uuid, e);
      fail++;
    }
  }

  syncing = false;
  scheduleRender("sync-done");
  syncStatus.textContent =
    `补传完成：新入库 ${ok} 笔` +
    (dup ? `，服务器已有 ${dup} 笔（未重复入库）` : "") +
    (fail ? `，失败 ${fail} 笔（仍保留在待传）` : "");
});

/* ---------- 启动 ---------- */
renderPending();
