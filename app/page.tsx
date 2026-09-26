"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Roi = { area: number; mean: number; stdDev: number; min: number; max: number; median: number };
type DoseField = "kv" | "scanTime" | "dose" | "hvl";
type DoseRow = Record<DoseField, string> & { source?: string; capturedAt?: string };
type Meter = "RTI Piranha" | "ACCU-GOLD2";
type MeasurementMode = "CT" | "Dental" | "Radiography / Fluoroscopy";
type LightMode = "luminance" | "illuminance" | "ambient";
type LightSample = { value: number; at: number };
type RawPacket = { at: number; source: string; text: string; hex: string; bytes: number };
type SerialPortLike = {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  readable?: ReadableStream<Uint8Array> | null;
  connected?: boolean;
  getInfo?: () => { bluetoothServiceClassId?: string | number; usbProductId?: number; usbVendorId?: number };
};
type BluetoothCharacteristicLike = EventTarget & {
  value?: DataView;
  startNotifications: () => Promise<BluetoothCharacteristicLike>;
  stopNotifications: () => Promise<BluetoothCharacteristicLike>;
};
type BluetoothDeviceLike = {
  id: string;
  name?: string;
  gatt?: {
    connected: boolean;
    connect: () => Promise<{ getPrimaryService: (uuid: string) => Promise<{ getCharacteristic: (uuid: string) => Promise<BluetoothCharacteristicLike> }> }>;
    disconnect: () => void;
  };
};

declare global {
  interface Navigator {
    serial?: { requestPort: (options?: { allowedBluetoothServiceClassIds?: string[] }) => Promise<SerialPortLike>; getPorts: () => Promise<SerialPortLike[]> };
    bluetooth?: { requestDevice: (options: { acceptAllDevices?: boolean; filters?: Array<{ namePrefix: string }>; optionalServices?: string[] }) => Promise<BluetoothDeviceLike>; getDevices?: () => Promise<BluetoothDeviceLike[]> };
  }
}

const positions = ["ขอบบน", "ขอบขวา", "ขอบล่าง", "ขอบซ้าย", "จุดกลาง"];
const modes = [
  { value: "0.4 mm", criteria: "-10% ถึง 10%", min: -10, max: 10 },
  { value: "0.25 mm", criteria: "10% ถึง 30%", min: 10, max: 30 },
  { value: "0.2 mm (FOV 12×6 cm)", criteria: "0% ถึง 20%", min: 0, max: 20 },
  { value: "0.2 mm (FOV 8×8 cm)", criteria: "-10% ถึง 10%", min: -10, max: 10 },
];
const blankDoseRow = (): DoseRow => ({ kv: "", scanTime: "", dose: "", hvl: "" });
const aliases: Record<DoseField, string[]> = {
  kv: ["kv", "kvp", "peak kv", "measured kv", "kilovoltage"],
  scanTime: ["scan time", "time", "exposure time", "duration", "ms", "s"],
  dose: ["dose", "mgy", "air kerma", "kerma"],
  hvl: ["hvl", "hvl mm al", "mm al", "half value layer"],
};

function Icon({ name, size = 18 }: { name: "upload" | "file" | "shield" | "check" | "x" | "flask" | "plug" | "wave" | "trash"; size?: number }) {
  const paths = {
    upload: <><path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></>,
    check: <path d="m5 12 4 4L19 6"/>, x: <path d="m6 6 12 12M18 6 6 18"/>,
    flask: <><path d="M9 3h6M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7 15h10"/></>,
    plug: <><path d="M12 22v-5M9 8V2m6 6V2M6 8h12v3a6 6 0 0 1-12 0z"/></>,
    wave: <path d="M3 12h3l2-7 4 14 3-10 2 3h4"/>,
    trash: <><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6m4-6v6"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{paths[name]}</svg>;
}

const normalizeHeader = (value: string) => value.toLowerCase().replace(/[()\[\]_%]/g, " ").replace(/[^a-z0-9ก-๙]+/g, " ").trim();
const toNumber = (value?: string) => Number(String(value ?? "").replace(/\s/g, "").replace(",", ".").replace(/[^0-9.+-]/g, ""));
const splitLine = (line: string) => line.split(line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",").map((v) => v.trim().replace(/^"|"$/g, ""));
const findColumn = (headers: string[], field: DoseField) => headers.findIndex((header) => aliases[field].some((alias) => header === alias || header.includes(alias)));

function parseCsv(text: string): Roi[] {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 6) throw new Error("ไฟล์ต้องมีหัวตารางและข้อมูล ROI อย่างน้อย 5 แถว");
  const headers = splitLine(lines[0]).map(normalizeHeader);
  const col = (name: string) => headers.indexOf(normalizeHeader(name));
  for (const name of ["Area", "Mean", "StdDev", "Min", "Max", "Median"]) if (col(name) < 0) throw new Error(`ไม่พบคอลัมน์ ${name}`);
  return lines.slice(1, 6).map((line, index) => {
    const values = splitLine(line);
    const number = (name: string) => { const value = toNumber(values[col(name)]); if (!Number.isFinite(value)) throw new Error(`ข้อมูล ${name} แถวที่ ${index + 1} ไม่ถูกต้อง`); return value; };
    return { area: number("Area"), mean: number("Mean"), stdDev: number("StdDev"), min: number("Min"), max: number("Max"), median: number("Median") };
  });
}

function parseMeterText(text: string, source: Meter): DoseRow[] {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const labelledCandidates = lines.length > 1 ? [...lines, text.replace(/[\r\n]+/g, ", ")] : lines;
  const labelled = labelledCandidates.map((line) => {
    const get = (field: DoseField) => {
      for (const alias of aliases[field]) {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = line.match(new RegExp(`${escaped}\\s*[:=]\\s*([+-]?\\d+(?:[.,]\\d+)?)`, "i"));
        if (match) return String(toNumber(match[1]));
      }
      return "";
    };
    return { kv: get("kv"), scanTime: get("scanTime"), dose: get("dose"), hvl: get("hvl"), source, capturedAt: new Date().toISOString() };
  }).filter((row) => [row.kv, row.scanTime, row.dose, row.hvl].every(Boolean));
  if (labelled.length) return labelled;

  const headerIndex = lines.findIndex((line) => {
    const header = splitLine(line).map(normalizeHeader);
    return (["kv", "scanTime", "dose", "hvl"] as DoseField[]).filter((field) => findColumn(header, field) >= 0).length >= 3;
  });
  if (headerIndex < 0) throw new Error("ไม่พบหัวคอลัมน์ kV, Scan time, Dose และ HVL");
  const headers = splitLine(lines[headerIndex]).map(normalizeHeader);
  const columns = Object.fromEntries((["kv", "scanTime", "dose", "hvl"] as DoseField[]).map((field) => [field, findColumn(headers, field)])) as Record<DoseField, number>;
  if (Object.values(columns).some((index) => index < 0)) throw new Error("ไฟล์ต้องมีคอลัมน์ kV, Scan time, Dose และ HVL");
  const timeHeader = headers[columns.scanTime];
  return lines.slice(headerIndex + 1).map(splitLine).map((values) => {
    let scanTime = toNumber(values[columns.scanTime]);
    if (/\bms\b/.test(timeHeader)) scanTime /= 1000;
    return { kv: String(toNumber(values[columns.kv])), scanTime: String(scanTime), dose: String(toNumber(values[columns.dose])), hvl: String(toNumber(values[columns.hvl])), source, capturedAt: new Date().toISOString() };
  }).filter((row) => [row.kv, row.scanTime, row.dose, row.hvl].every((value) => Number.isFinite(Number(value)) && Number(value) > 0));
}

const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
function sampleSd(values: number[]) { if (values.length < 2) return 0; const mean = avg(values); return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)); }
const fmt = (value: number, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : "—";
const bluetoothLabel = (device: BluetoothDeviceLike, meter: Meter, index?: number) => {
  const suffix = device.id?.slice(-6) || (index !== undefined ? String(index + 1) : "—");
  return device.name?.trim() || `${meter} • ID ${suffix}`;
};
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const androidChromeVersion = () => {
  if (typeof navigator === "undefined" || !/Android/i.test(navigator.userAgent)) return null;
  const match = navigator.userAgent.match(/(?:Chrome|CriOS)\/(\d+)/i);
  return match ? Number(match[1]) : 0;
};
const lightModes: Array<{ value: LightMode; label: string; unit: string; description: string }> = [
  { value: "luminance", label: "Luminance — Monitor", unit: "cd/m²", description: "ความสว่างของจอภาพ" },
  { value: "illuminance", label: "Illuminance — Light source", unit: "lx", description: "ความส่องสว่างจากแหล่งกำเนิดแสง" },
  { value: "ambient", label: "Ambient light", unit: "lx", description: "แสงแวดล้อมด้วย lux adapter" },
];
function parseLightValue(line: string) {
  const labelled = line.match(/(?:luminance|illuminance|ambient|light|lux|cd\/m2|cd\/m²|value)\s*[:=,]\s*([+-]?\d+(?:[.,]\d+)?)/i);
  const unitAfter = line.match(/([+-]?\d+(?:[.,]\d+)?)\s*(?:lx|lux|cd\s*\/\s*m(?:2|²))/i);
  const match = labelled ?? unitAfter;
  if (!match) return null;
  const value = toNumber(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export default function Home() {
  const [tab, setTab] = useState<"uniform" | "dose" | "light">("dose");
  const [mode, setMode] = useState(modes[1].value);
  const [rois, setRois] = useState<Roi[]>([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const meterFileRef = useRef<HTMLInputElement>(null);
  const serialPortRef = useRef<SerialPortLike | null>(null);
  const serialReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const serialBufferRef = useRef("");
  const exposureSamplesRef = useRef<DoseRow[]>([]);
  const exposureSourceRef = useRef("");
  const exposureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredSessionRef = useRef(false);
  const bluetoothDeviceRef = useRef<BluetoothDeviceLike | null>(null);
  const knownBluetoothDevicesRef = useRef<BluetoothDeviceLike[]>([]);
  const bluetoothCharacteristicRef = useRef<BluetoothCharacteristicLike | null>(null);
  const stopSerialRef = useRef(false);
  const [meter, setMeter] = useState<Meter>("RTI Piranha");
  const [measurementMode, setMeasurementMode] = useState<MeasurementMode>("CT");
  const [transport, setTransport] = useState<"serial" | "bluetooth">("serial");
  const [sessionName, setSessionName] = useState("QA Session 1");
  const [baudRate, setBaudRate] = useState("115200");
  const [serviceUuid, setServiceUuid] = useState("");
  const [characteristicUuid, setCharacteristicUuid] = useState("");
  const [knownPortCount, setKnownPortCount] = useState<number | null>(null);
  const [bluetoothDeviceName, setBluetoothDeviceName] = useState("");
  const [knownBluetoothNames, setKnownBluetoothNames] = useState<string[]>([]);
  const [doseCaptureEnabled, setDoseCaptureEnabled] = useState(false);
  const [lightMode, setLightMode] = useState<LightMode>("luminance");
  const [lightSamples, setLightSamples] = useState<LightSample[]>([]);
  const [lightRecording, setLightRecording] = useState(true);
  const [rawPackets, setRawPackets] = useState<RawPacket[]>([]);
  const [receivedBytes, setReceivedBytes] = useState(0);
  const [meterStatus, setMeterStatus] = useState<"idle" | "reading" | "connected" | "error">("idle");
  const [meterMessage, setMeterMessage] = useState("เลือกมิเตอร์ แล้วนำเข้าผลหรือเชื่อมต่อ Web Serial");
  const [factor, setFactor] = useState("0.95");
  const [doseRows, setDoseRows] = useState<DoseRow[]>(Array.from({ length: 5 }, blankDoseRow));
  const [waveField, setWaveField] = useState<DoseField>("kv");
  const [exportMessage, setExportMessage] = useState("");
  const [fixedScanTime, setFixedScanTime] = useState("");
  const [exposureTimeout, setExposureTimeout] = useState("1200");
  const [pendingExposure, setPendingExposure] = useState<DoseRow | null>(null);
  const [pendingSampleCount, setPendingSampleCount] = useState(0);
  const [mobileChromeVersion, setMobileChromeVersion] = useState<number | null>();
  const androidRfcommReady = mobileChromeVersion !== undefined && mobileChromeVersion !== null && mobileChromeVersion >= 138 && Boolean(navigator.serial);
  useEffect(() => {
    try {
      const savedRows = sessionStorage.getItem("rti-dose-rows");
      const savedPackets = sessionStorage.getItem("rti-raw-packets");
      const rows = savedRows ? JSON.parse(savedRows) as DoseRow[] : null;
      const packets = savedPackets ? JSON.parse(savedPackets) as RawPacket[] : null;
      queueMicrotask(() => {
        if (rows) setDoseRows(rows);
        if (packets) {
          setRawPackets(packets);
          setReceivedBytes(packets.reduce((sum, packet) => sum + packet.bytes, 0));
        }
        restoredSessionRef.current = true;
      });
    } catch { restoredSessionRef.current = true; }
  }, []);
  useEffect(() => { queueMicrotask(() => setMobileChromeVersion(androidChromeVersion())); }, []);
  useEffect(() => { if (restoredSessionRef.current) sessionStorage.setItem("rti-dose-rows", JSON.stringify(doseRows)); }, [doseRows]);
  useEffect(() => { if (restoredSessionRef.current) sessionStorage.setItem("rti-raw-packets", JSON.stringify(rawPackets)); }, [rawPackets]);
  useEffect(() => () => { if (exposureTimerRef.current) clearTimeout(exposureTimerRef.current); }, []);
  const result = useMemo(() => {
    if (rois.length !== 5) return null;
    const edgeMean = avg(rois.slice(0, 4).map((r) => r.mean));
    const uniformity = ((rois[4].mean - edgeMean) * 100) / (edgeMean + 1000);
    const noise = (avg(rois.map((r) => r.stdDev)) * 100) / (rois[4].mean + 1000);
    const limits = modes.find((item) => item.value === mode)!;
    return { edgeMean, uniformity, noise, passUniform: uniformity >= limits.min && uniformity <= limits.max, passNoise: noise >= -10 && noise <= 10, limits };
  }, [rois, mode]);
  const validRows = useMemo(() => doseRows.filter((row) => (["kv", "scanTime", "dose", "hvl"] as DoseField[]).every((field) => Number(row[field]) > 0)), [doseRows]);
  const current = pendingExposure ?? validRows.at(-1) ?? null;
  const doseResult = useMemo(() => {
    if (validRows.length !== 5) return null;
    const calibration = Number(factor);
    if (!Number.isFinite(calibration) || calibration <= 0) return null;
    const values = (field: DoseField) => validRows.map((row) => Number(row[field]));
    const calibratedKv = values("kv").map((value) => value * calibration);
    const metric = (items: number[], limit: number) => ({ mean: avg(items), sd: sampleSd(items), cv: 100 * sampleSd(items) / avg(items), limit });
    return { calibratedKv, kv: metric(calibratedKv, 2), scan: metric(values("scanTime"), 5), dose: metric(values("dose"), 5), hvlMean: avg(values("hvl")), hvlPass: values("hvl").every((value) => value > 2.5) };
  }, [validRows, factor]);
  const lightStats = useMemo(() => {
    const values = lightSamples.map((sample) => sample.value);
    return values.length ? { current: values.at(-1)!, min: Math.min(...values), max: Math.max(...values), mean: avg(values) } : null;
  }, [lightSamples]);
  function averageExposure(samples: DoseRow[], source: string): DoseRow {
    const meanField = (field: DoseField) => String(avg(samples.map((sample) => Number(sample[field]))));
    return { kv: meanField("kv"), scanTime: meanField("scanTime"), dose: meanField("dose"), hvl: meanField("hvl"), source, capturedAt: new Date().toISOString() };
  }
  function finalizeExposure() {
    if (exposureTimerRef.current) clearTimeout(exposureTimerRef.current);
    exposureTimerRef.current = null;
    const samples = exposureSamplesRef.current;
    if (!samples.length) return;
    const averaged = averageExposure(samples, `${exposureSourceRef.current} • เฉลี่ย ${samples.length} samples`);
    exposureSamplesRef.current = [];
    exposureSourceRef.current = "";
    setPendingExposure(null);
    setPendingSampleCount(0);
    addMeasurements([averaged], averaged.source ?? meter);
    setMeterMessage(`จบรอบการวัดและบันทึกค่าเฉลี่ยจาก ${samples.length} samples แล้ว — รอรังสีรอบใหม่`);
  }
  function collectExposureSamples(rows: DoseRow[], source: string) {
    if (!rows.length) return;
    exposureSamplesRef.current.push(...rows);
    exposureSourceRef.current = source;
    const averaged = averageExposure(exposureSamplesRef.current, `${source} • กำลังวัด`);
    setPendingExposure(averaged);
    setPendingSampleCount(exposureSamplesRef.current.length);
    setMeterMessage(`ตรวจพบรังสี — กำลังเก็บ sample ที่ ${exposureSamplesRef.current.length}`);
    if (exposureTimerRef.current) clearTimeout(exposureTimerRef.current);
    const timeout = Math.max(100, Number(exposureTimeout) || 1200);
    exposureTimerRef.current = setTimeout(finalizeExposure, timeout);
  }
  function ingestMeterChunk(decoded: string, source: string) {
    serialBufferRef.current = `${serialBufferRef.current}${decoded}`.slice(-8192);
    const completeParts = serialBufferRef.current.split(/[\r\n]+/);
    serialBufferRef.current = completeParts.pop() ?? "";
    const completeText = completeParts.join("\n");
    if (completeText) {
      const light = parseLightValue(completeText);
      if (light !== null && lightRecording) setLightSamples((samples) => [...samples, { value: light, at: Date.now() }].slice(-300));
      if (doseCaptureEnabled) {
        try {
          const rows = parseMeterText(completeText, meter);
          if (rows.length) collectExposureSamples(rows, source);
          else serialBufferRef.current = `${completeText}\n${serialBufferRef.current}`.slice(-8192);
        } catch {
          serialBufferRef.current = `${completeText}\n${serialBufferRef.current}`.slice(-8192);
        }
      }
    }
    if (doseCaptureEnabled) {
      try {
        const rows = parseMeterText(serialBufferRef.current, meter);
        if (rows.length) { collectExposureSamples(rows, source); serialBufferRef.current = ""; }
      } catch { /* wait for the rest of this measurement */ }
    }
  }
  function startDoseCapture() {
    setDoseCaptureEnabled(true);
    setMeterMessage(`พร้อมรับค่าโหมด ${measurementMode} แล้ว — รอการยิงรังสี`);
  }
  function stopDoseCapture() {
    finalizeExposure();
    setDoseCaptureEnabled(false);
    setMeterMessage(`หยุดรับค่าชั่วคราว — การเชื่อมต่อ ${meter} ยังทำงานอยู่`);
  }
  function resetDoseCapture() {
    if (exposureTimerRef.current) clearTimeout(exposureTimerRef.current);
    exposureTimerRef.current = null;
    exposureSamplesRef.current = [];
    exposureSourceRef.current = "";
    setPendingExposure(null);
    setPendingSampleCount(0);
    setDoseRows(Array.from({ length: 5 }, blankDoseRow));
    setRawPackets([]);
    setReceivedBytes(0);
    serialBufferRef.current = "";
    const stillConnected = meterStatus === "connected";
    setDoseCaptureEnabled(stillConnected);
    setMeterMessage(stillConnected
      ? `รีเซ็ตข้อมูลแล้ว — พร้อมรับค่า ${measurementMode} ใหม่ทันที`
      : "รีเซ็ตข้อมูลแล้ว — เชื่อมต่อมิเตอร์เพื่อเริ่มรับค่า");
  }
  function applyFixedScanTime() {
    const value = Number(fixedScanTime);
    if (!Number.isFinite(value) || value <= 0) return;
    setDoseRows((rows) => rows.map((row) => ({ ...row, scanTime: String(value), source: row.source ?? "Manual fixed time" })));
  }
  function clearFixedScanTime() {
    setFixedScanTime("");
    setDoseRows((rows) => rows.map((row) => ({ ...row, scanTime: "" })));
  }
  const rowsToExport = doseRows.filter((row) => (["kv", "scanTime", "dose", "hvl"] as DoseField[]).some((field) => row[field].trim() !== ""));
  const exportFileName = () => `${sessionName.trim().replace(/[^a-zA-Z0-9ก-๙_-]+/g, "-") || "rti-measurements"}-${new Date().toISOString().slice(0, 10)}`;
  const exportHeaders = ["No.", "Captured at", "kV", "Calibrated kV", "Scan time (s)", "Dose (mGy)", "HVL (mm Al)"];
  function exportValues(row: DoseRow, index: number): Array<string | number> {
    const numeric = (value: string) => value.trim() === "" || !Number.isFinite(Number(value)) ? "" : Number(value);
    const kv = numeric(row.kv);
    return [index + 1, row.capturedAt ? new Date(row.capturedAt).toLocaleString("th-TH") : "", kv, typeof kv === "number" && Number(factor) > 0 ? kv * Number(factor) : "", numeric(row.scanTime), numeric(row.dose), numeric(row.hvl)];
  }
  function saveDownload(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = fileName; anchor.click();
    URL.revokeObjectURL(url);
  }
  function exportCsv() {
    if (!rowsToExport.length) return;
    const escape = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const csv = [exportHeaders, ...rowsToExport.map(exportValues)].map((row) => row.map(escape).join(",")).join("\r\n");
    saveDownload(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }), `${exportFileName()}.csv`);
    setExportMessage(`ส่งออก CSV แล้ว ${rowsToExport.length} รายการ`);
  }
  async function exportXlsx() {
    if (!rowsToExport.length) return;
    try {
      setExportMessage("กำลังสร้างไฟล์ Excel…");
      const ExcelJS = await import("exceljs");
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "Radiography QA Calculator";
      workbook.created = new Date();
      const sheet = workbook.addWorksheet("Measurements", { views: [{ state: "frozen", ySplit: 1 }] });
      sheet.addRow(exportHeaders);
      rowsToExport.forEach((row, index) => sheet.addRow(exportValues(row, index)));
      sheet.columns = [{ width: 8 }, { width: 23 }, { width: 12 }, { width: 16 }, { width: 16 }, { width: 15 }, { width: 16 }];
      sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D4ED8" } };
      sheet.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
      sheet.getRow(1).height = 24;
      sheet.autoFilter = { from: "A1", to: "G1" };
      [3, 4, 5, 6, 7].forEach((column) => { sheet.getColumn(column).numFmt = "0.000"; });
      sheet.eachRow((row, rowNumber) => { if (rowNumber > 1) row.alignment = { vertical: "middle" }; });
      const buffer = await workbook.xlsx.writeBuffer();
      saveDownload(new Blob([buffer as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${exportFileName()}.xlsx`);
      setExportMessage(`ส่งออก XLSX แล้ว ${rowsToExport.length} รายการ`);
    } catch (error) {
      setExportMessage(error instanceof Error ? `สร้าง XLSX ไม่สำเร็จ: ${error.message}` : "สร้าง XLSX ไม่สำเร็จ");
    }
  }
  function recordRaw(bytes: Uint8Array, textValue: string, source: string) {
    const hex = Array.from(bytes.slice(0, 48), (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    setReceivedBytes((total) => total + bytes.byteLength);
    setRawPackets((packets) => [...packets, { at: Date.now(), source, text: textValue.replace(/[\r\n]+/g, " ↵ ").slice(0, 180), hex, bytes: bytes.byteLength }].slice(-30));
  }

  async function handleFile(file?: File) {
    if (!file) return; setError("");
    if (!file.name.toLowerCase().endsWith(".csv")) { setError("รองรับเฉพาะไฟล์ .csv"); return; }
    if (file.size > 5 * 1024 * 1024) { setError("ไฟล์ต้องมีขนาดไม่เกิน 5 MB"); return; }
    try { setRois(parseCsv(await file.text())); setFileName(file.name); } catch (e) { setRois([]); setFileName(""); setError(e instanceof Error ? e.message : "อ่านไฟล์ไม่สำเร็จ"); }
  }
  function onDrop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setDragging(false); handleFile(event.dataTransfer.files[0]); }
  function updateDose(index: number, field: DoseField, value: string) { setDoseRows((rows) => rows.map((row, i) => i === index ? { ...row, [field]: value, source: row.source ?? "Manual" } : row)); }
  function addMeasurements(rows: DoseRow[], label: string) {
    if (!rows.length) throw new Error("ไม่พบข้อมูลการวัดที่สมบูรณ์");
    setDoseRows((existing) => {
      const populated = existing.filter((row) => Number(row.kv) > 0);
      const combined = [...populated, ...rows].slice(-5);
      return combined.concat(Array.from({ length: Math.max(0, 5 - combined.length) }, blankDoseRow));
    });
    setMeterStatus("connected");
    setMeterMessage(`${label}: อ่านข้อมูลสำเร็จ ${rows.length} ค่า (ใช้ 5 ค่าล่าสุด)`);
  }
  async function handleMeterFile(file?: File) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setMeterStatus("error"); setMeterMessage("ไฟล์ต้องมีขนาดไม่เกิน 10 MB"); return; }
    try { addMeasurements(parseMeterText(await file.text(), meter), file.name); }
    catch (e) { setMeterStatus("error"); setMeterMessage(e instanceof Error ? e.message : "อ่านไฟล์ไม่สำเร็จ"); }
    finally { if (meterFileRef.current) meterFileRef.current.value = ""; }
  }
  async function connectSerial(existingPort?: SerialPortLike) {
    if (!navigator.serial) { setMeterStatus("error"); setMeterMessage("เบราว์เซอร์นี้ไม่รองรับ Web Serial — ใช้ Chrome/Edge หรือส่งออก CSV จากซอฟต์แวร์มิเตอร์"); return; }
    try {
      setMeterStatus("reading"); setMeterMessage("กำลังรอเลือกพอร์ต…"); stopSerialRef.current = false;
      const port = existingPort ?? await navigator.serial.requestPort(); serialPortRef.current = port;
      const baud = Number(baudRate);
      if (!Number.isInteger(baud) || baud <= 0) throw new Error("Baud rate ไม่ถูกต้อง");
      await port.open({ baudRate: baud }); setMeterStatus("connected"); setDoseCaptureEnabled(true); setMeterMessage(`${sessionName}: เชื่อมต่อ ${meter} ผ่าน Web Serial แล้ว และกำลังรอค่าการวัด`);
      const reader = port.readable?.getReader();
      if (!reader) throw new Error("พอร์ตไม่มีข้อมูลให้อ่าน");
      serialReaderRef.current = reader;
      const decoder = new TextDecoder();
      while (!stopSerialRef.current) {
        const { value, done } = await reader.read(); if (done) break;
        const decoded = decoder.decode(value, { stream: true }); recordRaw(value, decoded, `${meter} Serial`);
        ingestMeterChunk(decoded, `${meter} • ${measurementMode}`);
      }
      reader.releaseLock(); serialReaderRef.current = null;
    } catch (e) {
      const cancelled = e instanceof DOMException && (e.name === "NotFoundError" || /No Port Selected/i.test(e.message));
      const onAndroid = /Android/i.test(navigator.userAgent);
      setMeterStatus(cancelled ? "idle" : "error");
      setMeterMessage(cancelled ? (onAndroid ? "ไม่ได้เลือก Piranha — จับคู่มิเตอร์ใน Android Bluetooth ก่อน แล้วกดเลือก Piranha / COM port ใหม่ (ต้องใช้ Chrome 138 ขึ้นไป)" : "ยกเลิกการเลือกพอร์ต หรือไม่พบพอร์ตที่รองรับ") : e instanceof Error ? e.message : "เชื่อมต่อมิเตอร์ไม่สำเร็จ");
    }
  }
  async function querySerialPorts() {
    if (!navigator.serial) { setMeterStatus("error"); setMeterMessage("เบราว์เซอร์นี้ไม่รองรับ Web Serial"); return; }
    try {
      setMeterStatus("reading"); setMeterMessage("กำลังค้นหาพอร์ตที่เคยอนุญาต…");
      const ports = await navigator.serial.getPorts(); setKnownPortCount(ports.length);
      if (!ports.length) {
        setMeterStatus("idle");
        setMeterMessage("ยังไม่มี Piranha/พอร์ตที่เว็บเคยได้รับอนุญาต — กด ‘เลือก Piranha / COM port’ เพื่อเลือก Bluetooth RFCOMM ครั้งแรก");
        return;
      }
      setMeterMessage(`พบ ${ports.length} พอร์ตที่ได้รับอนุญาต กำลังเชื่อมต่อพอร์ตแรก…`);
      await connectSerial(ports[0]);
    } catch (e) { setMeterStatus("error"); setMeterMessage(e instanceof Error ? e.message : "ค้นหาพอร์ตไม่สำเร็จ"); }
  }
  async function connectBluetooth(existingDevice?: BluetoothDeviceLike, filterByMeter = false) {
    if (!navigator.bluetooth) { setMeterStatus("error"); setMeterMessage("เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth — ใช้ Chrome/Edge หรือจับคู่ Bluetooth เป็น COM port แล้วเลือก Web Serial"); return; }
    if (/Android/i.test(navigator.userAgent) && !existingDevice && (!serviceUuid.trim() || !characteristicUuid.trim())) {
      setMeterStatus("error");
      setMeterMessage(`${meter} ไม่ประกาศ BLE GATT ที่เว็บอ่านได้ จึงไม่เปิดการค้นหาที่ยาวโดยไม่มี UUID — ใช้ USB-OTG/Serial หรือระบุ UUID จาก SDK ผู้ผลิต`);
      return;
    }
    try {
      setMeterStatus("reading"); setMeterMessage(existingDevice ? "กำลังเชื่อมต่ออุปกรณ์ที่เคยอนุญาต…" : "กำลังรอเพิ่มอุปกรณ์ Bluetooth ใหม่…");
      const hasUuids = Boolean(serviceUuid.trim() && characteristicUuid.trim());
      const prefixes = meter === "RTI Piranha" ? ["Piranha", "RTI"] : ["ACCU", "Accu", "Radcal", "AG2"];
      const discovery = filterByMeter ? { filters: prefixes.map((namePrefix) => ({ namePrefix })) } : { acceptAllDevices: true };
      const device = existingDevice ?? await navigator.bluetooth.requestDevice({ ...discovery, ...(hasUuids ? { optionalServices: [serviceUuid.trim()] } : {}) });
      if (!device.gatt) throw new Error("อุปกรณ์ไม่มี Bluetooth GATT — น่าจะเป็น Bluetooth Classic/SPP ซึ่ง Web Bluetooth เชื่อมต่อไม่ได้");
      const visibleName = bluetoothLabel(device, meter);
      bluetoothDeviceRef.current = device; setBluetoothDeviceName(visibleName);
      let server: Awaited<ReturnType<NonNullable<BluetoothDeviceLike["gatt"]>["connect"]>> | null = null;
      let lastGattError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          if (device.gatt.connected) device.gatt.disconnect();
          if (attempt > 1) { setMeterMessage(`กำลังเชื่อมต่อ ${visibleName} ใหม่ ครั้งที่ ${attempt}/3…`); await wait(attempt * 500); }
          server = await device.gatt.connect();
          break;
        } catch (error) { lastGattError = error; }
      }
      if (!server) throw lastGattError instanceof Error ? lastGattError : new Error("เชื่อมต่อ GATT ไม่สำเร็จหลังลอง 3 ครั้ง");
      if (!hasUuids) {
        setMeterStatus("connected");
        setMeterMessage(`${sessionName}: พบและเชื่อมต่อ ${visibleName} แล้ว — กรอก UUID เพื่อเปิดรับค่าการวัด`);
        return;
      }
      const service = await server.getPrimaryService(serviceUuid.trim());
      const characteristic = await service.getCharacteristic(characteristicUuid.trim());
      bluetoothCharacteristicRef.current = characteristic;
      const decoder = new TextDecoder();
      characteristic.addEventListener("characteristicvaluechanged", (event) => {
        const value = (event.target as BluetoothCharacteristicLike).value;
        if (!value) return;
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const decoded = decoder.decode(bytes, { stream: true }); recordRaw(bytes, decoded, `${meter} Bluetooth`);
        ingestMeterChunk(decoded, `${meter} Bluetooth • ${measurementMode}`);
      });
      await characteristic.startNotifications();
      setMeterStatus("connected"); setDoseCaptureEnabled(true); setMeterMessage(`${sessionName}: เชื่อมต่อ ${visibleName} ผ่าน Web Bluetooth แล้ว และกำลังรอค่าการวัด`);
    } catch (e) {
      const cancelled = e instanceof DOMException && (e.name === "NotFoundError" || /cancel|not found/i.test(e.message));
      setMeterStatus(cancelled ? "idle" : "error");
      const message = e instanceof Error ? e.message : "เชื่อมต่อ Bluetooth ไม่สำเร็จ";
      const friendly = /gatt.*disconnect|networkerror/i.test(message)
        ? "เชื่อมต่อ GATT ไม่สำเร็จหลังลอง 3 ครั้ง — ปิด Ocean/Accu‑Gold หรือแอปอื่นที่ต่อมิเตอร์อยู่ แล้วปิด–เปิด Bluetooth ของมือถือและมิเตอร์"
        : /service|uuid|characteristic/i.test(message)
          ? "เชื่อมต่ออุปกรณ์ได้ แต่ไม่พบบริการวัดค่า — ตรวจสอบ Service UUID และ Notify Characteristic UUID จาก SDK ของผู้ผลิต"
          : message;
      setMeterMessage(cancelled ? "ไม่ได้เลือกอุปกรณ์ Bluetooth หรือไม่มีอุปกรณ์ BLE กำลัง advertise" : friendly);
    }
  }
  async function queryKnownBluetoothDevices() {
    if (!navigator.bluetooth) { setMeterStatus("error"); setMeterMessage("เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth"); return; }
    if (!navigator.bluetooth.getDevices) {
      const onAndroid = /Android/i.test(navigator.userAgent);
      if (onAndroid) {
        setMeterStatus("error");
        setMeterMessage(`${meter} ไม่ได้ปรากฏเป็น BLE GATT บน Android จึงค้นหาด้วย Web Bluetooth ไม่พบ — เปลี่ยนเป็น Serial แล้วต่อ USB-OTG หรือใช้แอป/SDK ของผู้ผลิต`);
        setTransport("serial");
        return;
      }
      setMeterMessage("กำลังเปิดรายการแบบกรองเฉพาะมิเตอร์…");
      await connectBluetooth(undefined, true);
      return;
    }
    try {
      setMeterStatus("reading"); setMeterMessage("กำลังอ่านอุปกรณ์ Bluetooth ที่เว็บนี้เคยได้รับอนุญาต…");
      const devices = await navigator.bluetooth.getDevices();
      knownBluetoothDevicesRef.current = devices;
      setKnownBluetoothNames(devices.map((device, index) => bluetoothLabel(device, meter, index)));
      setMeterStatus("idle");
      setMeterMessage(devices.length ? `พบ ${devices.length} อุปกรณ์ที่เคยอนุญาต — เลือกอุปกรณ์ด้านล่าง` : "ยังไม่มีอุปกรณ์ที่เคยอนุญาตให้เว็บนี้ กด ‘เพิ่มอุปกรณ์ใหม่’ หนึ่งครั้ง");
    } catch (e) { setMeterStatus("error"); setMeterMessage(e instanceof Error ? e.message : "อ่านรายการ Bluetooth ไม่สำเร็จ"); }
  }
  async function startSession() {
    if (!sessionName.trim()) { setMeterStatus("error"); setMeterMessage("กรุณาตั้งชื่อ session"); return; }
    if (transport === "serial") await connectSerial(); else await connectBluetooth();
  }
  async function disconnectSerial() {
    stopSerialRef.current = true;
    try { await serialReaderRef.current?.cancel(); } catch { /* reader may already be closed */ }
    try { await serialPortRef.current?.close(); } catch { /* port may already be closed */ }
    serialReaderRef.current = null; serialPortRef.current = null;
    try { await bluetoothCharacteristicRef.current?.stopNotifications(); } catch { /* notifications may already be stopped */ }
    bluetoothDeviceRef.current?.gatt?.disconnect(); bluetoothCharacteristicRef.current = null; bluetoothDeviceRef.current = null; setBluetoothDeviceName("");
    setMeterStatus("idle"); setMeterMessage(`${sessionName}: สิ้นสุด session แล้ว`);
  }

  return <div className="min-h-screen bg-muted text-foreground">
    <header className="border-b bg-card"><div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-4 sm:px-6"><div className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground"><Icon name="flask" size={21}/></div><div><h1 className="text-base font-semibold leading-tight">Radiography QA Calculator</h1><p className="text-sm text-muted-foreground">รับค่าจากมิเตอร์ แสดงกราฟ และคำนวณตามแบบฟอร์มอ้างอิง</p></div></div></header>
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <Tabs value={tab} onValueChange={(value) => setTab(value as "uniform" | "dose" | "light")} className="mb-6 w-full sm:w-[560px]"><TabsList className="grid h-auto w-full grid-cols-3"><TabsTrigger value="uniform">Uniform &amp; Noise</TabsTrigger><TabsTrigger value="dose">Meter &amp; Dose</TabsTrigger><TabsTrigger value="light">Light Probe</TabsTrigger></TabsList></Tabs>
      {tab === "uniform" ? <div className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <section className="card"><div className="card-header"><h2>นำเข้าข้อมูล ROI</h2><p>อัปโหลดไฟล์ผลการวัดจากเครื่องมือในรูปแบบ CSV</p></div><div className="card-body space-y-5">
          <div><label className="label" htmlFor="mode">โหมดการสแกน</label><Select value={mode} onValueChange={setMode}><SelectTrigger id="mode" className="w-full"><SelectValue placeholder="เลือกโหมดการสแกน"/></SelectTrigger><SelectContent>{modes.map((item) => <SelectItem key={item.value} value={item.value}>{item.value}</SelectItem>)}</SelectContent></Select></div>
          <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => inputRef.current?.click()} className={`dropzone ${dragging ? "dropzone-active" : ""}`}><Input ref={inputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e: ChangeEvent<HTMLInputElement>) => handleFile(e.target.files?.[0])}/><div className="upload-icon"><Icon name="upload"/></div><p className="font-medium">ลากไฟล์ CSV มาวางที่นี่</p><p className="text-sm text-muted-foreground">หรือคลิกเพื่อเลือกไฟล์ • สูงสุด 5 MB</p></div>
          {error && <div className="alert alert-error"><Icon name="x" size={17}/><span>{error}</span></div>}
          {fileName && <div className="file-row"><Icon name="file"/><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{fileName}</p><p className="text-xs text-muted-foreground">อ่านข้อมูล 5 ตำแหน่งสำเร็จ</p></div><span className="status status-pass"><Icon name="check" size={14}/>พร้อมคำนวณ</span></div>}
        </div></section>
        <section className="card"><div className="card-header"><h2>ผลการคำนวณ</h2><p>{result ? `อ้างอิงเกณฑ์โหมด ${mode}` : "ผลลัพธ์จะแสดงหลังจากอัปโหลดไฟล์"}</p></div><div className="card-body">
          {!result ? <div className="empty"><div className="upload-icon"><Icon name="file"/></div><p>ยังไม่มีข้อมูลสำหรับคำนวณ</p><span>เลือกไฟล์ CSV เพื่อเริ่มต้น</span></div> : <div className="space-y-5"><div className="result-grid"><Result label="Uniformity" value={`${fmt(result.uniformity, 2)}%`} pass={result.passUniform} criteria={result.limits.criteria}/><Result label="Noise" value={`${fmt(result.noise, 2)}%`} pass={result.passNoise} criteria="-10% ถึง 10%"/></div><div className="rounded-lg border"><div className="table-scroll"><table><thead><tr><th>ตำแหน่ง</th><th>Mean (HU)</th><th>SD (HU)</th></tr></thead><tbody>{rois.map((roi, i) => <tr key={positions[i]}><td>{positions[i]}</td><td>{fmt(roi.mean)}</td><td>{fmt(roi.stdDev)}</td></tr>)}</tbody></table></div></div><div className="formula"><p>Mean เฉลี่ย 4 ขอบ <strong>{fmt(result.edgeMean)} HU</strong></p><p>Mean จุดกลาง <strong>{fmt(rois[4].mean)} HU</strong></p></div></div>}
        </div></section>
      </div> : tab === "dose" ? <div className="space-y-6">
        <section className="meter-grid">
          <div className="card"><div className="card-header"><h2>สร้าง Session เชื่อมต่อมิเตอร์</h2><p>RTI Piranha และ ACCU-GOLD2 ผ่าน Serial หรือ Bluetooth</p></div><div className="card-body space-y-4">
            <div className="session-fields"><div><label className="label" htmlFor="session-name">ชื่อ Session</label><Input id="session-name" value={sessionName} onChange={(e) => setSessionName(e.target.value)} placeholder="QA Session"/></div><div><label className="label" htmlFor="meter">มิเตอร์</label><Select value={meter} onValueChange={(value) => setMeter(value as Meter)}><SelectTrigger id="meter" className="w-full"><SelectValue placeholder="เลือกมิเตอร์"/></SelectTrigger><SelectContent><SelectItem value="RTI Piranha">RTI Piranha</SelectItem><SelectItem value="ACCU-GOLD2">ACCU-GOLD2</SelectItem></SelectContent></Select></div></div>
            <div><label className="label" htmlFor="measurement-mode">Measurement mode</label><Select value={measurementMode} onValueChange={(value) => setMeasurementMode(value as MeasurementMode)}><SelectTrigger id="measurement-mode" className="w-full"><SelectValue placeholder="เลือกโหมดการวัด"/></SelectTrigger><SelectContent><SelectItem value="CT">CT</SelectItem><SelectItem value="Dental">Dental</SelectItem><SelectItem value="Radiography / Fluoroscopy">Radiography / Fluoroscopy</SelectItem></SelectContent></Select><p className="field-note">เลือกให้ตรงกับโหมดที่ตั้งใน Piranha/Ocean ก่อนเริ่ม Session</p></div>
            <div><span className="label">การเชื่อมต่อ</span><Tabs value={transport} onValueChange={(value) => setTransport(value as "serial" | "bluetooth")}><TabsList className="grid h-auto w-full grid-cols-2"><TabsTrigger value="serial">Piranha Bluetooth / USB</TabsTrigger><TabsTrigger value="bluetooth">BLE ขั้นสูง</TabsTrigger></TabsList></Tabs></div>
            {transport === "serial" ? <div><label className="label" htmlFor="baud-rate">Baud rate</label><Select value={baudRate} onValueChange={setBaudRate}><SelectTrigger id="baud-rate" className="w-full"><SelectValue placeholder="เลือก Baud rate"/></SelectTrigger><SelectContent>{["9600", "19200", "38400", "57600", "115200"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select><div className="piranha-guide"><strong>เชื่อมต่อ Piranha ผ่าน Bluetooth Classic</strong><ol><li>จับคู่ Piranha ใน Windows Bluetooth ก่อน (PIN รุ่นทั่วไปคือ 0000)</li><li>ปิด Ocean Next หรือโปรแกรมอื่นที่กำลังใช้มิเตอร์</li><li>ใช้ Chrome/Edge 117+ แล้วกด “เลือก Piranha / COM port”</li></ol></div></div> : <div className="ble-fields">{bluetoothDeviceName && <div className="selected-device"><span>อุปกรณ์ที่เลือก</span><strong>{bluetoothDeviceName}</strong></div>}<div><label className="label" htmlFor="service-uuid">Service UUID</label><Input id="service-uuid" className="mono" value={serviceUuid} onChange={(e) => setServiceUuid(e.target.value)} placeholder="UUID จาก SDK ผู้ผลิต"/></div><div><label className="label" htmlFor="characteristic-uuid">Notify Characteristic UUID</label><Input id="characteristic-uuid" className="mono" value={characteristicUuid} onChange={(e) => setCharacteristicUuid(e.target.value)} placeholder="UUID จาก SDK ผู้ผลิต"/></div><p className="field-note">ใช้เฉพาะอุปกรณ์ที่ผู้ผลิตยืนยันว่าเป็น BLE GATT; Piranha รุ่น Bluetooth Classic ให้ใช้แท็บแรก</p></div>}
            {transport === "serial" ? <div className="serial-actions"><Button className="button button-primary" onClick={startSession} disabled={meterStatus === "reading" || meterStatus === "connected"}><Icon name="plug"/>เลือก Piranha / COM port</Button><Button className="button" onClick={querySerialPorts} disabled={meterStatus === "reading" || meterStatus === "connected"}>เชื่อมต่อพอร์ตเดิม</Button><span>{knownPortCount === null ? "รองรับ Bluetooth SPP และ USB Serial" : `พบพอร์ตเดิม ${knownPortCount} พอร์ต`}</span></div> : <div className="bluetooth-actions"><div className="bluetooth-search-grid"><Button className="button button-primary" onClick={queryKnownBluetoothDevices} disabled={meterStatus === "reading" || meterStatus === "connected"}><Icon name="plug"/>เชื่อมต่อ {meter}</Button><Button className="button" onClick={() => connectBluetooth(undefined, true)} disabled={meterStatus === "reading" || meterStatus === "connected"}>เลือกแบบกรองชื่อ</Button><Button className="button subtle-button" onClick={startSession} disabled={meterStatus === "reading" || meterStatus === "connected"}>แสดงอุปกรณ์ BLE ทั้งหมด</Button></div>{knownBluetoothNames.length > 0 && <div className="known-devices">{knownBluetoothNames.map((name, index) => <Button key={`${name}-${index}`} onClick={() => connectBluetooth(knownBluetoothDevicesRef.current[index])} disabled={meterStatus === "reading" || meterStatus === "connected"}><span className="connection-dot"/><span><strong>{name}</strong><small>เคยอนุญาตให้เว็บนี้</small></span></Button>)}</div>}</div>}
            <Button className="button full-button" onClick={() => meterFileRef.current?.click()}><Icon name="upload"/>นำเข้า CSV/TXT</Button><Input ref={meterFileRef} className="hidden" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => handleMeterFile(e.target.files?.[0])}/>
            {meterStatus === "connected" && <Button className="button button-danger" onClick={disconnectSerial}>หยุด Session และตัดการเชื่อมต่อ</Button>}
            <div className={`connection ${meterStatus}`}><span className="connection-dot"/><div><strong>{meterStatus === "connected" ? "พร้อมรับข้อมูล" : meterStatus === "reading" ? "กำลังเชื่อมต่อ" : meterStatus === "error" ? "ต้องตรวจสอบ" : "ยังไม่เชื่อมต่อ"}</strong><p>{meterMessage}</p></div></div>
            {transport === "serial" && mobileChromeVersion !== undefined && <div className={`mobile-note ${mobileChromeVersion !== null ? (androidRfcommReady ? "mobile-ready" : "mobile-warning") : ""}`}><strong>{mobileChromeVersion === null ? "Bluetooth Classic / RFCOMM" : androidRfcommReady ? `Android Chrome ${mobileChromeVersion}: พร้อมเลือก Bluetooth RFCOMM` : `Android Chrome ${mobileChromeVersion || "ไม่ทราบรุ่น"}: ต้องอัปเดต`}</strong><span>{mobileChromeVersion === null ? "Piranha ใช้เส้นทาง Web Serial ไม่ใช่ BLE GATT กรุณาจับคู่กับระบบก่อนเลือกพอร์ต" : androidRfcommReady ? "จับคู่ Piranha ใน Settings > Bluetooth ก่อน จากนั้นกด “เลือก Piranha / COM port” ด้านบน ไม่ต้องใช้แท็บ BLE ขั้นสูง" : "Bluetooth RFCOMM บน Android ต้องใช้ Chrome 138 ขึ้นไป หลังอัปเดตให้จับคู่ Piranha ใน Settings แล้วกลับมากดเลือกพอร์ต"}</span></div>}
            <p className="helper">รองรับข้อความรูปแบบหัวตาราง CSV/TSV หรือบรรทัด เช่น <code>kV=89.6, time=18.29, dose=3.065, HVL=5.61</code></p>
          </div></div>
          <div className="value-stack"><div className="card current-panel"><div className="card-header row-header"><div><h2>ค่าปัจจุบัน</h2><p>{current ? `${current.source ?? meter} • ${current.capturedAt ? new Date(current.capturedAt).toLocaleTimeString("th-TH") : "แก้ไขด้วยตนเอง"}` : "รอข้อมูลจากมิเตอร์"}</p></div><span className={`live-indicator ${doseCaptureEnabled ? "active" : ""}`}><span/> {pendingSampleCount ? `EXPOSURE • ${pendingSampleCount} samples` : doseCaptureEnabled ? `ARMED • ${measurementMode}` : "STOPPED"}</span></div><div className="card-body">
            {current ? <div className="current-grid"><CurrentValue label="kV" value={fmt(Number(current.kv), 2)} unit="kV"/><CurrentValue label="kV × factor" value={fmt(Number(current.kv) * Number(factor), 2)} unit="kV"/><CurrentValue label="Scan time" value={fmt(Number(current.scanTime), 3)} unit="s"/><CurrentValue label="Dose" value={fmt(Number(current.dose), 3)} unit="mGy"/><CurrentValue label="HVL" value={fmt(Number(current.hvl), 2)} unit="mm Al"/></div> : <div className="empty compact"><div className="upload-icon"><Icon name="wave"/></div><p>ยังไม่มีค่าการวัด</p><span>เชื่อมต่อมิเตอร์ นำเข้าไฟล์ หรือกรอกในตาราง</span></div>}
            <div className="exposure-settings"><div><label className="label" htmlFor="exposure-timeout">ตัดรอบเมื่อไม่พบรังสี</label><div className="input-with-unit"><Input id="exposure-timeout" type="number" min="100" step="100" inputMode="numeric" value={exposureTimeout} onChange={(event) => setExposureTimeout(event.target.value)} aria-describedby="exposure-timeout-note"/><span>ms</span></div></div><p id="exposure-timeout-note">เมื่อไม่มี sample ใหม่เกินเวลานี้ ระบบจะเฉลี่ย sample ทั้งหมดและบันทึกเป็นการวัด 1 ครั้ง</p></div>
            <div className="capture-actions"><div className="capture-buttons"><Button className="button button-primary" onClick={startDoseCapture} disabled={meterStatus !== "connected" || doseCaptureEnabled}><Icon name="wave"/>เริ่มรับค่า</Button><Button className="button" onClick={stopDoseCapture} disabled={!doseCaptureEnabled}><Icon name="x"/>หยุด</Button><Button className="button" onClick={resetDoseCapture}><Icon name="trash"/>รีเซ็ต</Button></div><small>{pendingSampleCount ? `กำลังวัดรอบนี้ ${pendingSampleCount} samples • ค่าแสดงผลเป็นค่าเฉลี่ยชั่วคราว` : meterStatus === "connected" ? "พร้อมตรวจจับรังสีอัตโนมัติ • ตารางจะเพิ่มหนึ่งแถวเมื่อครบ timeout" : "เชื่อมต่อมิเตอร์ก่อน ระบบจะเริ่มรับค่าให้อัตโนมัติ"}</small></div>
          </div></div><div className="card"><div className="card-header row-header"><div><h2>กราฟค่าที่วัด</h2><p>แนวโน้มของ 5 ค่าล่าสุด</p></div><div className="segmented">{(["kv", "scanTime", "dose", "hvl"] as DoseField[]).map((field) => <Button key={field} className={waveField === field ? "active" : ""} onClick={() => setWaveField(field)}>{field === "scanTime" ? "Time" : field.toUpperCase()}</Button>)}</div></div><div className="card-body"><WaveChart rows={validRows} field={waveField}/></div></div></div>
        </section>

        <section className="card"><div className="card-header row-header"><div><h2>คำนวณด้วยตนเอง</h2><p>คำนวณจากการสแกน 5 ครั้งตามแบบฟอร์มเดิม</p></div><div className="factor"><label htmlFor="factor">Calibration factor</label><Input id="factor" type="number" min="0" step="any" value={factor} onChange={(e) => setFactor(e.target.value)}/></div></div><div className="card-body space-y-5">
          <div className="preset-bar"><div><strong>Scan time คงที่</strong><span>กรอกครั้งเดียวเพื่อใส่เวลาลงทั้ง 5 แถว</span></div><div className="fixed-time-control"><div className="input-with-unit"><Input aria-label="Scan time คงที่" type="number" min="0" step="any" inputMode="decimal" value={fixedScanTime} onChange={(event) => setFixedScanTime(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyFixedScanTime(); }} placeholder="เช่น 0.5"/><span>s</span></div><Button className="button button-primary" onClick={applyFixedScanTime} disabled={!Number.isFinite(Number(fixedScanTime)) || Number(fixedScanTime) <= 0}>ใช้กับทั้ง 5 แถว</Button><Button className="button" onClick={clearFixedScanTime}>ล้างเวลา</Button></div></div>
          <div className="export-bar"><div><strong>ส่งออกค่าที่วัดได้</strong><span>{rowsToExport.length ? `มีข้อมูล ${rowsToExport.length} รายการ • รวมค่า Calibration factor ${factor}` : "ยังไม่มีข้อมูลสำหรับส่งออก"}</span></div><div className="export-actions"><Button className="button" onClick={exportCsv} disabled={!rowsToExport.length}><Icon name="file" size={16}/>Export CSV</Button><Button className="button button-primary" onClick={exportXlsx} disabled={!rowsToExport.length}><Icon name="file" size={16}/>Export XLSX</Button></div>{exportMessage && <p className="export-message" role="status">{exportMessage}</p>}</div>
          <div className="border"><div className="table-scroll"><table className="dose-table"><thead><tr><th rowSpan={2}>ครั้งที่</th><th>kV</th><th>kV × Calibration factor</th><th>Scan time</th><th>Dose</th><th>HVL</th></tr><tr className="unit-row"><th>kV</th><th>kV</th><th>s</th><th>mGy</th><th>mm Al</th></tr></thead><tbody>{doseRows.map((row, i) => <tr key={i}><td>{i + 1}</td><td><CellInput label={`kV ครั้งที่ ${i + 1}`} value={row.kv} onChange={(value) => updateDose(i, "kv", value)}/></td><td className="calibrated">{Number(row.kv) > 0 && Number(factor) > 0 ? fmt(Number(row.kv) * Number(factor)) : "—"}</td><td><CellInput label={`Scan time ครั้งที่ ${i + 1}`} value={row.scanTime} onChange={(value) => updateDose(i, "scanTime", value)}/></td><td><CellInput label={`Dose ครั้งที่ ${i + 1}`} value={row.dose} onChange={(value) => updateDose(i, "dose", value)}/></td><td><CellInput label={`HVL ครั้งที่ ${i + 1}`} value={row.hvl} onChange={(value) => updateDose(i, "hvl", value)}/></td></tr>)}</tbody></table></div></div>
          <div className="table-actions"><span>{validRows.length}/5 ค่าที่สมบูรณ์</span><Button className="text-button" onClick={() => { setDoseRows(Array.from({ length: 5 }, blankDoseRow)); setMeterMessage("ล้างข้อมูลแล้ว"); }}><Icon name="trash" size={15}/>ล้างตาราง</Button></div>
          {!doseResult ? <div className="info"><Icon name="shield" size={18}/><p><strong>ต้องมีข้อมูลครบ 5 ครั้ง</strong><br/><span>ระบบจะคำนวณ Mean, sample SD และ %CV เมื่อค่าทุกช่องมากกว่า 0</span></p></div> : <><div className="result-grid three"><DoseResult label="kV × factor" data={doseResult.kv}/><DoseResult label="Scan time" data={doseResult.scan}/><DoseResult label="Dose" data={doseResult.dose}/></div><div className={`alert ${doseResult.hvlPass ? "alert-success" : "alert-error"}`}>{doseResult.hvlPass ? <Icon name="check" size={17}/> : <Icon name="x" size={17}/>}HVL เฉลี่ย {fmt(doseResult.hvlMean, 2)} mm Al — {doseResult.hvlPass ? "ผ่านเกณฑ์ทุกครั้ง (> 2.5 mm Al)" : "ไม่ผ่านเกณฑ์"}</div></>}
        </div></section>
        <section className="card"><div className="card-header row-header"><div><h2>Meter RX diagnostics</h2><p>{measurementMode} • ตรวจสอบข้อมูลที่ส่งจากมิเตอร์หลังยิง</p></div><div className="rx-summary"><strong>{receivedBytes.toLocaleString()}</strong><span>bytes received</span></div></div><div className="card-body">{rawPackets.length ? <div className="raw-log">{rawPackets.slice().reverse().map((packet, index) => <div key={`${packet.at}-${index}`}><div><span>{new Date(packet.at).toLocaleTimeString("th-TH")}</span><strong>{packet.source}</strong><small>{packet.bytes} bytes</small></div><code>{packet.text || `(binary) ${packet.hex}`}</code>{packet.text && <code className="hex">HEX {packet.hex}</code>}</div>)}</div> : <div className="diagnostic-empty"><strong>หลังยิงแล้วยังไม่ได้รับข้อมูล</strong><span>ถ้า bytes received ยังเป็น 0 แสดงว่า Piranha ยังไม่ได้ stream มายัง session นี้ ให้เลือกโหมดเดียวกันใน Ocean/Piranha หรือใช้โปรโตคอล/SDK ของ RTI เพื่อส่งคำสั่ง Start Measurement</span></div>}</div></section>
      </div> : <div className="space-y-6">
        <section className="light-toolbar card"><div className="card-header row-header"><div><h2>RTI Piranha Light Probe</h2><p>วัด Luminance และ Illuminance แบบเรียลไทม์</p></div><span className={`status ${meterStatus === "connected" ? "status-pass" : "status-fail"}`}>{meterStatus === "connected" ? "เชื่อมต่อแล้ว" : "ยังไม่เชื่อมต่อ"}</span></div><div className="card-body light-controls"><div><label className="label" htmlFor="light-mode">โหมดการวัด</label><Select value={lightMode} onValueChange={(value) => setLightMode(value as LightMode)}><SelectTrigger id="light-mode" className="w-full"><SelectValue placeholder="เลือกโหมดแสง"/></SelectTrigger><SelectContent>{lightModes.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select><p className="field-note">{lightModes.find((item) => item.value === lightMode)?.description}</p></div><div className="light-actions"><Button className={`button ${lightRecording ? "button-danger" : "button-primary"}`} onClick={() => setLightRecording((value) => !value)}>{lightRecording ? "หยุดบันทึก" : "เริ่มบันทึก"}</Button><Button className="button" onClick={() => setLightSamples([])}><Icon name="trash" size={15}/>ล้างข้อมูล</Button></div>{meterStatus !== "connected" && <div className="info"><Icon name="plug" size={18}/><p><strong>เชื่อมต่อ Piranha ก่อนเริ่มวัด</strong><br/><span>ไปที่แท็บ Meter &amp; Dose เพื่อเปิด Session เดียวกัน ข้อมูล Light Probe จะถูกส่งมายังหน้านี้อัตโนมัติ</span></p></div>}</div></section>
        <section className="light-kpis">{lightStats ? <><CurrentValue label="Realtime" value={fmt(lightStats.current, 2)} unit={lightModes.find((item) => item.value === lightMode)!.unit}/><CurrentValue label="Maximum" value={fmt(lightStats.max, 2)} unit={lightModes.find((item) => item.value === lightMode)!.unit}/><CurrentValue label="Minimum" value={fmt(lightStats.min, 2)} unit={lightModes.find((item) => item.value === lightMode)!.unit}/><CurrentValue label="Average" value={fmt(lightStats.mean, 2)} unit={lightModes.find((item) => item.value === lightMode)!.unit}/></> : <div className="light-empty-kpi">รอค่าจาก Light Probe เช่น <code>luminance=245.6</code> หรือ <code>lux=18.2</code></div>}</section>
        <section className="card"><div className="card-header row-header"><div><h2>Light waveform</h2><p>{lightSamples.length} samples • แสดง 300 ค่าล่าสุด</p></div><span className={`live-indicator ${lightRecording ? "active" : ""}`}><span/> {lightRecording ? "LIVE" : "PAUSED"}</span></div><div className="card-body"><LightChart samples={lightSamples} unit={lightModes.find((item) => item.value === lightMode)!.unit}/></div></section>
        <section className="card"><div className="card-header"><h2>ค่าล่าสุด</h2><p>ประวัติ 20 samples ล่าสุด</p></div><div className="card-body"><div className="table-scroll"><table><thead><tr><th>เวลา</th><th>โหมด</th><th>ค่าแสง</th><th>หน่วย</th></tr></thead><tbody>{lightSamples.slice(-20).reverse().map((sample, index) => <tr key={`${sample.at}-${index}`}><td>{new Date(sample.at).toLocaleTimeString("th-TH")}</td><td>{lightModes.find((item) => item.value === lightMode)!.label}</td><td>{fmt(sample.value, 3)}</td><td>{lightModes.find((item) => item.value === lightMode)!.unit}</td></tr>)}</tbody></table></div></div></section>
        <section className="card"><div className="card-header row-header"><div><h2>Raw RX diagnostics</h2><p>ตรวจสอบว่ามิเตอร์ส่งข้อมูลเข้ามาจริงหรือไม่</p></div><div className="rx-summary"><strong>{receivedBytes.toLocaleString()}</strong><span>bytes received</span></div></div><div className="card-body">{rawPackets.length ? <div className="raw-log">{rawPackets.slice().reverse().map((packet, index) => <div key={`${packet.at}-${index}`}><div><span>{new Date(packet.at).toLocaleTimeString("th-TH")}</span><strong>{packet.source}</strong><small>{packet.bytes} bytes</small></div><code>{packet.text || `(binary) ${packet.hex}`}</code>{packet.text && <code className="hex">HEX {packet.hex}</code>}</div>)}</div> : <div className="diagnostic-empty"><strong>ยังไม่ได้รับข้อมูลแม้แต่ 1 byte</strong><span>ถ้ายิงหรือเปิดแสงแล้วค่ายังเป็น 0 แสดงว่ามิเตอร์ไม่ได้ stream ข้อมูลมายัง connection นี้ หรือจำเป็นต้องส่งคำสั่ง Start Measurement ตามโปรโตคอล RTI ก่อน</span></div>}</div></section>
      </div>}
    </main><footer className="mx-auto flex max-w-7xl items-center gap-2 px-4 pb-8 text-xs text-muted-foreground sm:px-6"><Icon name="shield" size={14}/> ค่าทั้งหมดประมวลผลในอุปกรณ์นี้ โปรดตรวจสอบหน่วยและผลก่อนใช้ทางคลินิก</footer>
  </div>;
}

function CellInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <Input aria-label={label} type="number" min="0" step="any" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0.00"/>; }
function CurrentValue({ label, value, unit }: { label: string; value: string; unit: string }) { return <div className="current-value"><span>{label}</span><strong>{value}</strong><small>{unit}</small></div>; }
function Result({ label, value, pass, criteria }: { label: string; value: string; pass: boolean; criteria: string }) { return <div className="result-card"><div className="flex items-center justify-between"><span>{label}</span><span className={`status ${pass ? "status-pass" : "status-fail"}`}>{pass ? <Icon name="check" size={14}/> : <Icon name="x" size={14}/>} {pass ? "ผ่าน" : "ไม่ผ่าน"}</span></div><strong>{value}</strong><small>เกณฑ์ {criteria}</small></div>; }
function DoseResult({ label, data }: { label: string; data: { mean: number; sd: number; cv: number; limit: number } }) { const pass = data.cv <= data.limit; return <div className="result-card"><div className="flex items-center justify-between"><span>{label}</span><span className={`status ${pass ? "status-pass" : "status-fail"}`}>{pass ? "ผ่าน" : "ไม่ผ่าน"}</span></div><strong>{fmt(data.cv, 3)}%</strong><small>Mean {fmt(data.mean)} • SD {fmt(data.sd)} • เกณฑ์ CV ≤ {data.limit}%</small></div>; }
function WaveChart({ rows, field }: { rows: DoseRow[]; field: DoseField }) {
  const values = rows.map((row) => Number(row[field]));
  const labels: Record<DoseField, string> = { kv: "kV", scanTime: "s", dose: "mGy", hvl: "mm Al" };
  if (!values.length) return <div className="chart-empty"><Icon name="wave" size={25}/><span>กราฟจะแสดงเมื่อมีค่าการวัด</span></div>;
  const min = Math.min(...values), max = Math.max(...values), spread = max - min || Math.max(max * 0.1, 1);
  const points = values.map((value, i) => `${24 + (i * 552) / Math.max(values.length - 1, 1)},${156 - ((value - min) / spread) * 112}`).join(" ");
  return <div className="wave-wrap"><div className="wave-scale"><span>{fmt(max, 2)} {labels[field]}</span><span>{fmt(min, 2)} {labels[field]}</span></div><svg className="wave-chart" viewBox="0 0 600 180" role="img" aria-label={`กราฟ ${field}`}><defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2563eb" stopOpacity=".22"/><stop offset="1" stopColor="#2563eb" stopOpacity="0"/></linearGradient></defs><path d="M24 44H576M24 100H576M24 156H576" className="grid-line"/><polygon points={`24,156 ${points} 576,156`} fill="url(#area)"/><polyline points={points} className="wave-line"/>{values.map((value, i) => { const x = 24 + (i * 552) / Math.max(values.length - 1, 1); const y = 156 - ((value - min) / spread) * 112; return <g key={i}><circle cx={x} cy={y} r="5" className="wave-dot"/><text x={x} y="174" textAnchor="middle">{i + 1}</text></g>; })}</svg></div>;
}
function LightChart({ samples, unit }: { samples: LightSample[]; unit: string }) {
  if (!samples.length) return <div className="chart-empty"><Icon name="wave" size={25}/><span>กราฟจะแสดงเมื่อได้รับค่าจาก Light Probe</span></div>;
  const visible = samples.slice(-100), values = visible.map((sample) => sample.value);
  const min = Math.min(...values), max = Math.max(...values), spread = max - min || Math.max(max * 0.1, 1);
  const points = values.map((value, index) => `${24 + (index * 552) / Math.max(values.length - 1, 1)},${156 - ((value - min) / spread) * 112}`).join(" ");
  return <div className="wave-wrap"><div className="wave-scale"><span>{fmt(max, 2)} {unit}</span><span>{fmt(min, 2)} {unit}</span></div><svg className="wave-chart light-wave" viewBox="0 0 600 180" role="img" aria-label="กราฟค่าแสงแบบเรียลไทม์"><defs><linearGradient id="light-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f59e0b" stopOpacity=".3"/><stop offset="1" stopColor="#f59e0b" stopOpacity="0"/></linearGradient></defs><path d="M24 44H576M24 100H576M24 156H576" className="grid-line"/><polygon points={`24,156 ${points} 576,156`} fill="url(#light-area)"/><polyline points={points} className="light-wave-line"/></svg></div>;
}
