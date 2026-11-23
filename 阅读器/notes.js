"use strict";

const Notes = (() => {
  const imagePattern = /^data:image\/(?:png|jpeg|webp|gif|bmp|avif);base64,[a-z0-9+/]+={0,2}$/i;
  const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/avif"]);
  const string = (value) => typeof value === "string" ? value : "";
  const date = (value) => Number.isFinite(Date.parse(value));

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("paper-workbench:" + location.pathname, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("notes", {keyPath: "id"});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function write(db, records) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("notes", "readwrite");
      const store = tx.objectStore("notes");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      for (const record of records) store.put(record);
    });
  }

  function list(db) {
    return new Promise((resolve, reject) => {
      const request = db.transaction("notes").objectStore("notes").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function clean(record) {
    if (!record || typeof record !== "object" || !string(record.id) ||
        (record.paperId != null && !string(record.paperId)) || !date(record.updatedAt)) {
      throw new Error("笔记 ID、论文 ID 或修改时间无效。");
    }
    const base = {id: record.id, paperId: record.paperId ?? null, updatedAt: new Date(record.updatedAt).toISOString()};
    if (record.deleted === true) return {...base, deleted: true};

    const images = record.images ?? [];
    if (!Array.isArray(images) || images.some((image) => !image || typeof image.data !== "string" || !imagePattern.test(image.data))) {
      throw new Error("有笔记图片格式无效。");
    }
    return {
      ...base,
      createdAt: date(record.createdAt) ? new Date(record.createdAt).toISOString() : base.updatedAt,
      versionId: string(record.versionId),
      pageLayout: string(record.pageLayout),
      page: Number.isSafeInteger(record.page) && record.page > 0 ? record.page : null,
      title: string(record.title),
      body: string(record.body),
      images: images.map((image) => ({name: string(image.name), data: image.data}))
    };
  }

  function parse(raw) {
    const backup = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (backup?.schemaVersion !== 1 || !Array.isArray(backup.notes)) {
      throw new Error("请选择论文工作台导出的笔记 JSON。");
    }
    return backup.notes.map(clean);
  }

  function serialize(records) {
    return JSON.stringify({schemaVersion: 1, notes: records}, null, 2) + "\n";
  }

  function merge(db, incoming) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("notes", "readwrite");
      const store = tx.objectStore("notes");
      const request = store.getAll();
      let changes = 0;
      tx.oncomplete = () => resolve(changes);
      tx.onabort = () => reject(tx.error);
      request.onsuccess = () => {
        const existing = new Map(request.result.map((record) => [record.id, record]));
        for (const record of incoming) {
          const previous = existing.get(record.id);
          if (!previous || record.updatedAt > previous.updatedAt ||
              (record.updatedAt === previous.updatedAt && record.deleted && !previous.deleted)) {
            store.put(record);
            existing.set(record.id, record);
            changes += 1;
          }
        }
      };
    });
  }

  function fromImage(file) {
    return new Promise((resolve, reject) => {
      if (!imageTypes.has(file.type)) {
        reject(new Error("可添加 PNG、JPG、WebP、GIF、BMP 或 AVIF 图片。"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve({name: file.name || "截图", data: reader.result});
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  return {open, write, list, parse, serialize, merge, fromImage};
})();

