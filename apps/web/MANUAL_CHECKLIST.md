# Web manual checklist (no browser automation on this machine)

Backend: `DATABASE_URL=... pnpm --filter @bactrack/api dev` (port 3001).
Web: `NEXT_PUBLIC_API_BASE=http://<host>:3001 pnpm --filter @bactrack/web dev` (port 3100).

- [ ] Login: open /login, submit email, magic link consumed (dev token auto-continues when ALLOW_DEV_MAGIC_TOKEN=true), lands on /.
- [ ] History: readings table renders; subject filter narrows; date filters narrow.
- [ ] Detail: click a reading → operator shown as "Tested by"; ack button visible only for subject; ack persists on reload.
- [ ] Devices: register C6 serial → provisioned; activate → active; release with no lease shows error message.
- [ ] Teams: invite second email as operator (owner); pending list shows it; accept as that user in another browser; members grows.
- [ ] Audit: actions appear after session/reading/invite flows; entity filter narrows.
- [ ] Map: OSM tiles load; count text matches readings; Dawarich toggle shows stub note.
- [ ] Org switcher: two orgs → switching changes history scope.
- [ ] Logout → /login; old refresh rejected.
