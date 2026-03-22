# OpenRoadmap Planner — UI Benutzerhandbuch (Enduser)

Dieses Dokument erklärt **nur die Bedienung der Web‑UI** (inkl. Agent/Chat), welche Daten wo gespeichert werden, welche Agent‑Tools verfügbar sind und wie die **3 Start-/Login‑Arten** verwendet werden.

URL nach Start: **http://localhost:3000**

---

## 0) Grundprinzip: Was ist „UI“, was ist „Import“?

- **Web‑UI**: Das, was du im Browser siehst (links Listen, in der Mitte Graph/Storyboard, rechts Agent‑Panel).
- **Datenbank (persistiert)**: Alles, was du in der UI änderst, landet serverseitig in:
  - `data/roadmap.json`
- **Scan‑Import (optional)**: Dateien in `scan/` sind **Import-/Sync‑Quellen**. Wenn du auf **Scan** drückst, werden `scan/*.srd.json` erneut eingelesen und in die Datenbank gemerged.
  - Wenn du nur *einmalig* importieren willst: Datei nach dem Scan aus `scan/` entfernen/archivieren.

---

## 1) Layout & Bereiche

### 1.1 Header (oben)
Im Header findest du zentrale Aktionen:

- **Change Roadmap Name**
  - Ändert den Namen, der im Header und Browser‑Tab angezeigt wird.
- **Edit Categories**
  - Bearbeitet die Kategorie‑Konfiguration (links) direkt in der UI.
- **Scan**
  - Importiert/merged `scan/*.srd.json`.
- **+ Neu**
  - Erstellt einen neuen Eintrag (System‑Node oder Storybeat).
- **Export**
  - Lädt einen JSON‑Export der aktuellen Daten herunter.
- **Agent**
  - Öffnet/Schließt das Agent‑Panel (Chat rechts).

### 1.2 Linke Seite: Kategorien & Node‑Liste
- Die linke Liste ist nach **Kategorien** gruppiert.
- Du kannst oben über **Suche** nach Titel oder REF‑ID filtern.
- Klick auf einen Node → öffnet rechts das **Detail‑Panel**.

### 1.3 Mitte: Graph / Storyboard
- Tab **Systeme**: Graph‑Canvas mit Punkten (Nodes) und Verbindungen.
- Tab **Storyboard**: Storybeat‑Liste als Timeline.

### 1.4 Rechts: Detail‑Panel (Node/Storybeat bearbeiten)
- Öffnet sich, wenn du einen Node/Storybeat auswählst.
- Alle Änderungen werden serverseitig gespeichert.

### 1.5 Rechts außen: Agent‑Panel (Chat)
- Öffnet über **Agent**.
- Ist horizontal **resizable** (breiter/schmaler ziehen).
- Eingabe ist ein 3‑Zeilen Textfeld:
  - **Enter** = senden
  - **Shift+Enter** = neue Zeile
- **Cancel** bricht einen laufenden Agent‑Run ab.

---

## 2) Kategorien konfigurieren (Edit Categories)

### 2.1 Wofür sind Kategorien?
Kategorien steuern:
- welche Gruppen links erscheinen
- Reihenfolge der Gruppen
- Anzeige‑Name
- Prefix für REF‑IDs
- Farbe (wird u.a. für Highlights genutzt)

### 2.2 Kategorien bearbeiten
1) Klick **Edit Categories**
2) Kategorien hinzufügen/ändern/löschen
3) **Save** drücken

Felder:
- **ID**: interne ID (muss eindeutig sein)
- **Name**: Anzeige in der UI
- **Prefix**: REF‑ID Prefix, z.B. `SRV` für `SRV-001`
- **Color**: z.B. `#00d4ff`
- **Description**: optional

Hinweis: Wenn du Kategorien löscht/umbenennst, können alte Nodes ohne passende Kategorie als **OTHER** erscheinen, bis du sie neu zuordnest.

---

## 3) Roadmap‑Name ändern (Change Roadmap Name)

1) Klick **Change Roadmap Name**
2) Namen eingeben
3) **Confirm** oder **Cancel**

Der Name wird gespeichert in:
- `data/roadmap.json` unter `meta.projectName`

---

## 4) System‑Nodes (Tab „Systeme“)

### 4.1 Einen Node auswählen
- Klick auf einen Node links in der Liste
- oder klick auf einen Punkt im Graph

### 4.2 Node bearbeiten (Detail‑Panel)
Du kannst u.a. ändern:
- **REF‑ID**
- **Titel**
- **Status**: `OFFEN` | `ENTSCHIEDEN` | `PRE-FORMULIERUNG`
- **Beschreibung**
- **Flags** (hinzufügen/entfernen)
- **Lösungsvorschlag / Code** Feld

### 4.3 Flags (Nodes)
- Flags hinzufügen: in das Flag‑Inputfeld tippen → **Enter**
- Flags entfernen: klick auf das Flag (mit `✕`)

---

## 5) Verbindungen (Connections) + Pfeil‑Flags

### 5.1 Was sind Connections?
Connections verbinden Nodes miteinander (z.B. Abhängigkeiten/Impacts). Sie werden im Graph als Linien dargestellt.

### 5.2 Connection hinzufügen
Im Detail‑Panel unter **Verbindungen**:
- nutze **+ Add / Flag**
- wähle **Target**, **Type** und optional die Pfeil‑Logik (arrowFlag)

### 5.3 Pfeile auf leuchtenden Linien: arrowFlag
Pfeile werden **nur angezeigt, wenn die Linie gerade highlighted/leuchtet**.

`arrowFlag` Werte:
- **to**: Pfeil zeigt **Origin → Target**
- **from**: Pfeil zeigt **Target → Origin**
- **both**: keine Pfeile (nur Glow)
- **unspecified**: keine Pfeile (nur Glow)

Wichtig:
- Diese Flag steuert **nur die Pfeile auf der Linie**, sonst nichts.

### 5.4 Connection Flagger (Popup)
Im Detail‑Panel bei einer Verbindung:
- **Flag** öffnet den Popup‑Dialog
- **Save** speichert
- **Cancel** bricht ab

Regel:
- Wenn kein Target gewählt ist → **Fehler: NO TARGET**

### 5.5 Connection entfernen
- Im Detail‑Panel bei der Verbindung: **✕**

---

## 6) Graph‑Bedienung (Tab „Systeme“)

- Mausrad: Zoom
- Drag (Maus gedrückt): Pan
- `+` / `−`: Zoom Buttons
- `⚙`: Reset Pan/Zoom

Highlights:
- Wenn du einen Node auswählst oder der Agent an einem Node arbeitet, werden relevante Elemente/Verbindungen hervorgehoben.

---

## 7) Storyboard (Tab „Storyboard“)

- **+ Beat**: neuen Storybeat anlegen
- Klick auf einen Beat: Bearbeiten im Detail‑Panel
- Felder:
  - Titel
  - Typ: `scene` oder `cut`
  - Reihenfolge (order) + optional act
  - Beschreibung
  - Game‑Referenzen
  - Notizen

---

## 8) Agent‑Panel (Chat) — Bedienung

### 8.1 Chat senden
- Text schreiben
- **Enter**: senden
- **Shift+Enter**: neue Zeile

### 8.2 Cancel (Abbrechen)
- Während der Agent läuft, erscheint **Cancel**.
- Cancel bricht den aktuellen Run ab.
- Danach siehst du:
  - „Anfrage abgebrochen, war noch was?“

### 8.3 Ticker/Status
Der Ticker zeigt:
- busy/idle
- Laufzeit (Sekunden)
- zuletzt gesendeter Input (Task)
- aktive/letzte Refs (Glow‑Feedback)

---

## 9) Agent‑Tools / Commands (was der Agent ausführen kann)

Der Agent kann (je nach Startmodus) Roadmap‑Operationen über MCP‑Tools ausführen.
Tool‑Namen (MCP):

### Meta / Kategorien
- `roadmap_get_meta`
- `roadmap_set_project_name`
- `roadmap_list_categories`
- `roadmap_update_categories`

### Nodes
- `roadmap_get_node`
- `roadmap_list_nodes`
- `roadmap_create_node`
- `roadmap_update_node`
- `roadmap_delete_node`
- `roadmap_move_node`

### Storybeats
- `roadmap_list_storybeats`
- `roadmap_create_storybeat`
- `roadmap_update_storybeat`
- `roadmap_delete_storybeat`
- `roadmap_move_storybeat`

### Connections
- `roadmap_list_connections`
- `roadmap_add_connection`
- `roadmap_remove_connection`

### Utility
- `roadmap_get_db_summary`
- `roadmap_validate_refs`
- `roadmap_scan`
- `roadmap_mark_working`

Hinweis: Welche dieser Tools *tatsächlich* ausführbar sind, hängt vom Startmodus ab (siehe nächster Abschnitt).

---

## 10) Die 3 Start-/Login‑Arten (3 Batch‑Dateien)

OpenRoadmap Planner kann den Agent/Chat über drei Modi betreiben. Du startest jeweils den passenden Modus über die `*.bat` Datei.

### 10.1 Gateway‑Mode (OpenClaw Gateway)
Start:
- `start-roadmap-gateway.bat`

Eigenschaften:
- Chat läuft über den lokalen OpenClaw Gateway.
- Tool‑Verfügbarkeit kann je nach Setup variieren.

### 10.2 ACP‑Mode (ACPX + OpenClaw ACP)
Start:
- `start-roadmap-acp.bat`

Eigenschaften:
- Empfohlen, wenn du Tool‑Nutzung stabil/deterministisch brauchst.

### 10.3 Direct‑Mode (API Key)
Start:
- `start-roadmap-direct.bat`

Eigenschaften:
- Server spricht direkt mit dem LLM (API key ist nötig).

---

## 11) Wo liegen meine Daten?

- Persistente Daten (UI‑Eingaben):
  - `data/roadmap.json`

- Import-/Sync‑Quellen (nur wenn du Scan nutzt):
  - `scan/*.srd.json`

---

## 12) Troubleshooting (UI)

### Kategorien „kommen wieder“ / OTHER erscheint
- OTHER ist ein Fallback für Nodes ohne gültige Kategoriezuordnung.
- Prüfe, ob Nodes noch alte `categoryId` Werte haben oder Prefixe nicht passen.

### Scan importiert „alte“ Dinge erneut
- `scan/*.srd.json` bleibt Quelle, solange die Datei dort liegt.
- Entferne/archiviere die Datei, wenn du nur einmalig importieren wolltest.
