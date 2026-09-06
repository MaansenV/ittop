# Memory-Screen Redesign — Plan (kein Code)

Stand: Entwurf aus User-Feedback vom Live-Rauchtest (2026-09-06), NICHT
freigegeben, NICHT implementiert. User-Befunde: kein Workspace-Wechsel im
Screen, nichts sichtbar ohne Suche, technische Darstellung (Keys, JSON,
UUIDs) statt lesbarer Karten, Optik nicht modern. Richtung: Workspace
auswählen → direkt browsen → Suche/Filter verfeinern → lesbar öffnen →
Rohdaten optional.

## 1. Informationsarchitektur (neu)

Header: Workspace-Switcher (Namen, keine UUIDs) + Scope-Anzeige (Default:
ausgewählter Workspace; global nur per separater Wahl) + Counts. Darunter: Browse-Liste (alle Memories des Workspaces,
paginiert) mit Suche-als-Filter und Kategorie-/Tag-Filtern. Detail: lesbare
Karte (Titel, Badges, Inhalt) + einklappbare Rohdaten + History-Timeline.
Raw-/Agent-Ansicht bleibt als Toggle erhalten (nichts Bestehendes entfernen).

## 2. Workspace-Switcher

- Quelle: App-Store (Renderer kennt Workspaces mit Namen — kein neues IPC).
- Angezeigt: Name pro Workspace (Counts NUR für den ausgewählten
  Workspace, nie automatisch für andere); aktive Markierung; global als
  separater, klar getrennter Bereich (kein Vermischen ohne explizite Wahl).
- Scope-Regel: Klick = explizite Freigabe genau dieses Workspaces für die
  Session (Default ohne Cross-Recall bleibt gewahrt); Multi-Select nur mit
  zusätzlicher Bestätigung. IDs nur als Tooltip, nie als Label.

## 3. Browse-first (Backend-Gate)

- Beim Öffnen/Wechseln lädt die Liste SOFORT alle Memories des Workspaces
  (begrenzt + Paginierung/Nachladen, kein unbegrenzter Dump).
- Backend-Kandidat: `perseus_vault_memories` (MCP-Tool, existiert) — VOR
  Nutzung vermessen wie Phase 2e (Zähler/Decay/Links vorher/nachher auf
  Temp-DB; nur bei Null-Effekt freigeben). Fällt die Messung negativ aus:
  kein Browse-Backend → Plan-Stop, Alternative vorlegen (kein stilles
  FTS-/Recall-Hacken als Ersatz).
- Suche wird Seitenfilter über der geladenen Menge (Label „Filter") +
  vertiefende Backend-Suche (Label „Suche", bestehender Dense-Pfad,
  fail-closed) nur auf explizite Aktion.

## 4. Lesbare Karten (Feld-Mapping)

- Titel: aus Key humanisiert (Bindestriche → Leerzeichen, Satzform).
- Badges: Kategorie, Status, Tags, Datum (lesbar, keine Unix-Stempel).
- Inhalt: formatierter Body-Text prominent; Summary vs. Detail getrennt.
- Versteckt (aufklappbar): IDs, UUIDs, Retrieval-/Decay-Rohwerte (als
  Balken/%-Anzeige in Kurzform), Timestamps, FTS-/Embedding-Felder.
- History: Timeline (Version, Zeitpunkt, Kurz-Diff) statt Roh-JSON.
- Leere/Lade/Auswahl-Zustände explizit gestalten (keine leeren Flächen).

## 5. Organisation

- Gruppierung: Kategorie, ersatzweise Thema/Aktualität (Umschalter).
- Filter: Kategorie-Chips (bestehend, behalten), Tag-Filter, Status-Filter.
- Sortierung: Aktualität (Default), Titel, Nutzung. Paginierung ab
  Schwelle (Vorschlag: 50, dann Nachladen).

## 6. Optik (Rahmen, kein Redesign-Mockup in dieser Phase)

- Dunkles Theme behalten; Karten statt Fließtext-Zeilen; klare Typo-
  Hierarchie (Titel/Content/Meta), größere Abstände, höherer Kontrast
  bei Sekundärtext; aktive Zustände sichtbar; responsive Zwei-Spalten-
  Layout bleibt (Liste + Detail).

## 7. Beantwortete Advisor-Fragen (verbindlich)

1. Switcher zeigt ALLE bekannten App-Workspaces als Navigation; geladen
   wird AUSSCHLIESSLICH der ausgewählte. KEINE automatische
   Cross-Workspace-Abfrage (auch nicht für Counts); KEINE DB-Erzeugung
   durch Browse (existiert keine DB → leerer Zustand + Hinweis).
2. Namen aus App-Store, Fallback „Unbenannter Workspace“; UUID nur unter
   Details/Tooltip, nie als Label.
3. Global ist eine SEPARATE Auswahl neben Workspaces; Default ist NUR der
   Workspace (das alte „Home + global“ entfällt ersatzlos). Mischen nur per
   expliziter Multi-Auswahl mit Bestätigung.
4. Renderer ausschließlich über validierten IPC-/Broker-Endpunkt;
   `memories` ist dessen interner Backend-Kandidat (kein Direktzugriff
   vom Renderer). Vor Implementierung isoliert vermessen: Schema, Filter,
   stabile Sortierung, Paging, Count-Semantik, Nebenwirkungsfreiheit
   (2e-Muster). Unbekannte Counts werden als „–“ gezeigt, nie erfunden.
5. Inhalt aus `body_json` sicher dekodieren (defensive Parses, nie
   crashen); Titel/Kategorie/Tags/Status/Datum menschenlesbar; fehlende
   Summary NICHT erfinden (Feld entfällt dann); Telemetrie korrekt
   beschriftet (retrieval = Anzahl, decay = %, kein Jargon ohne Label).
6. Raw-Toggle ist NUR Darstellung (JSON-Ansicht derselben Daten) — keine
   erweiterten Rechte, keine Secret-Freigabe (Redaktion gilt überall).
7. Leere Suche = Browse (lädt/aktualisiert die Workspace-Liste).
   Klare Trennung: Seitenfilter (filtert geladene Seite, Label „Filter“)
   vs. globale Suche (fragt Backend, Label „Suche“) — Seitenfilter wird
   NIE als vollständige Workspace-Suche dargestellt.
8. Kontextwechsel (Workspace/Scope/Disable) invalidiert Ergebnisse,
   Details, History UND verspätete Antworten (Generationen-Prinzip aus
   Phase 4, gilt weiter).

## 8. Textueller Layoutentwurf

```
+---------------------------------------------------------------+
| Memory   [Workspace: KinemationTest ▾] [Scope: Workspace] [x] |
+---------------------------------------------------------------+
| [Search........] [Search]   | Detail: Titel aus Key          |
| Chips: all(11) decision(7) | Badges: decision · active ·    |
| Tags:[v] Status:[v] Sort:[v]| Tags · Datum                    |
| +-------------------------+ |                                  |
| | Karte: Titel            | | Lesbarer Inhalt (formatiert)   |
| | Badges  Snippet ...     | |                                  |
| | Karte: Titel            | | [Historie ▸] [Rohdaten JSON ▸] |
| | ... (scroll, + Nachl.)  | |                                  |
+-----------------------------+-------------------------------+
```

(Zahlen im Entwurf sind Beispiele; echte Counts kommen aus dem Backend.)

## 9. Abnahmekriterien

- Browse-ohne-Suche: Öffnen zeigt Liste ohne Suchbegriff.
- Workspace-Wechsel: Liste/Detail/History resetten, Counts stimmen,
  keine alten/fremden Einträge, keine DB-Erzeugung.
- Global-Trennung: Default nur Workspace; global nur per expliziter Wahl.
- Paging: Schwelle einhalten, Nachladen vollständig, Counts konsistent.
- Fehlerzustände: Backend-Fehler, leere DB, fehlende Rechte je sichtbar.
- Tastatur: Suche fokussierbar, Liste navigierbar, Esc schließt.
- Schmale Fenster: einspaltig, kein Überlapp, kein Infoverlust.

## 10. Nicht-Ziele und Locks

- Keine Writes, kein Review-Flow-Umbau, keine Scope-Aufweichung, keine
  Live-Aktivierung durch diesen Plan. Implementierung erst nach
  Plan-Freigabe, pro Baustein mit eigenem Gate (7a-Muster).
