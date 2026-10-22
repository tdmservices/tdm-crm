/* Push notifications for the web app. Registered by the Profile page when the user turns push on. */
self.addEventListener("push", e => {
  let data = { title: "TDM CRM", body: "", url: "/#/" };
  try { data = { ...data, ...e.data.json() }; } catch { /* ignore */ }
  e.waitUntil(self.registration.showNotification(data.title, { body: data.body, data: { url: data.url }, icon: "/icon.png" }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/#/";
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { if ("focus" in c) { c.navigate(url); return c.focus(); } }
    return clients.openWindow(url);
  }));
});
