# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Electron-Desktop-App; Renderer ist Chromium. Vom User unwidersprochen als `web` festgehalten.)

## Users

Solo-Entwickler (Vibe-Coder), die mehrere KI-Agenten-Sessions (Claude Code, Codex CLI, Gemini CLI u. a.) parallel fahren. Situation: mehrere Projekte/Agenten gleichzeitig, ständiges Kontextwechseln. Job: alle Sessions gekachelt im Blick behalten, sofort sehen welche Session wartet, ohne Alt-Tab und ohne separates Terminal-Programm.

## Product Purpose

ittop organisiert parallele Terminal-Agenten-Sessions in Workspaces auf Windows und macOS. Es existiert, weil Agenten-CLIs keine Mehrfenster-Führung mitbringen. Erfolg heißt: ein Klick öffnet alles gekachelt, Wartezeiten erreichen den Nutzer (Live-Status + Notification), Dateien sind ohne Editor-Wechsel einsehbar.

## Positioning

Nicht ein Agenten-Ersatz, sondern die fehlende Schicht darum: Tiling per Klick, Live-Status pro Session, Desktop-Notifications, eingebauter File-Explorer mit Preview, kompatibel mit Voice-Diktat-Tools. Der Startbefehl jedes Terminals ist ein beliebiger String — dadurch funktioniert jedes terminalbasierte Agenten-CLI, nicht nur `claude`.

## Operating Context

- Windows-Desktop (ConPTY) primär, macOS als zweite Plattform (unsigned Build).
- Workspaces gruppieren Terminals (je eigener Ordner + Startkommando), geöffnet als Kacheln.
- Voice-Diktat-Tools (Wispr Flow, Windows Voice Access u. a.) landen per Copy/Paste korrekt in der Agenten-UI.
- Verteilung über GitHub Releases mit Auto-Update; Backup/Restore für Workspaces/Settings.
- Lokaler Embedded-Memory-Vault (Perseus) als experimentelle, lokale Erweiterung — kein Cloud-Zwang.

## Capabilities and Constraints

Fix (nicht verhandelbar): 100 % gratis, MIT-Open-Source, keine Telemetrie, kein Account, kein Cloud-Zwang, lokal-first. Windows + macOS werden unterstützt.

Verhandelbar (User-Entscheid 2026-09-06): Theme-Anzahl (heute 5 — Reduktion denkbar), UI-Sprache (Deutsch/Englisch offen), Extras als Kür (Voice-Kompatibilität, Notifications, File-Explorer sind willkommen, aber kein Pflichtumfang).

Terminologie: Workspace (Gruppe), Terminal (Session: Ordner + Startkommando), Memory (lokaler Vault), Review-Queue (Freigabe-Schritt vor Vault-Schreibzugriff).

Offen: keine weiteren Produktentscheidungen ausstehend.

## Brand Commitments

Name ittop, dunkles Theme als Standard, pragmatisch-nüchterner Ton (kein Marketing-Sprech). Keine bindenden visuellen Vorgaben darüber hinaus vom User gemacht.

## Evidence on Hand

- README.md (Produktversprechen, Plattform-Badges, Screenshots-Sektion), package.json (Name, Version, MIT).
- Laufende Codebasis + App (H:/ittop, `npm run dev`); Memory-Screen-Redesign als aktuelle Baustelle (docs/memory/).
- Abwesenheiten, die künftige Arbeit nicht erfinden darf: keine Testimonials, keine Benchmarks, keine Kundennamen, keine Preis-/Lizenzaussagen über MIT hinaus.

## Product Principles

1. Die Agenten bleiben das Produkt — ittop ist die Schicht darum und ersetzt kein CLI.
2. Parallel als Normalfall: ein Klick, alles gekachelt, Wartezeiten kommen zum Nutzer.
3. Lokal, gratis, privat: keine Konten, keine Cloud, keine Telemetrie — dauerhaft.
4. Kein Alt-Tab-Arbeiten: Status, Dateien und Freigaben passieren in der App.
5. Zurückhaltung bei Schreibzugriffen: mächtige Aktionen (z. B. Memory-Promotion) nur über explizite Freigabe-Schritte.
