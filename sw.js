self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { data: { body: event.data && event.data.text() } }; }
  const data = payload.data || payload.notification || {};
  event.waitUntil(self.registration.showNotification(data.title || "עוד שקל לילד", {
    body: data.body || "", icon: "icon-192.png", badge: "icon-192.png", tag: data.tag || "od-shekel", data: { view: data.view || "" }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window" }).then((list) => {
    if (list.length) return list[0].focus();
    return self.clients.openWindow("./");
  }));
});
