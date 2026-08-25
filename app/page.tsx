"use client";

import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";

type Roi = { area: number; mean: number; stdDev: number; min: number; max: number; median: number };
type DoseRow = { kv: string; scanTime: string; dose: string; hvl: string };
const positions = ["ขอบบน", "ขอบขวา", "ขอบล่าง", "ขอบซ้าย", "จุดกลาง"];
const modes = [
  { value: "0.4 mm", criteria: "-10% ถึง 10%", min: -10, max: 10 },
  { value: "0.25 mm", criteria: "10% ถึง 30%", min: 10, max: 30 },
  { value: "0.2 mm (FOV 12×6 cm)", criteria: "0% ถึง 20%", min: 0, max: 20 },
  { value: "0.2 mm (FOV 8×8 cm)", criteria: "-10% ถึง 10%", min: -10, max: 10 },
];

function Icon({ name, size = 18 }: { name: "upload" | "file" | "shield" | "check" | "x" | "flask"; size?: number }) {
  const paths = {
    upload: <><path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></>,
    check: <path d="m5 12 4 4L19 6"/>, x: <path d="m6 6 12 12M18 6 6 18"/>,
    flask: <><path d="M9 3h6M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7 15h10"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{paths[name]}</svg>;
}
function parseCsv(text: string): Roi[] {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 6) throw new Error("ไฟล์ต้องมีหัวตารางและข้อมูล ROI อย่างน้อย 5 แถว");
  const headers = lines[0].split(",").map((v) => v.trim().toLowerCase());
  const col = (name: string) => headers.indexOf(name.toLowerCase());
  for (const name of ["Area", "Mean", "StdDev", "Min", "Max", "Median"]) if (col(name) < 0) throw new Error(`ไม่พบคอลัมน์ ${name}`);
  return lines.slice(1, 6).map((line, index) => {
    const values = line.split(",").map((v) => v.trim());
    const number = (name: string) => { const value = Number(values[col(name)]); if (!Number.isFinite(value)) throw new Error(`ข้อมูล ${name} แถวที่ ${index + 1} ไม่ถูกต้อง`); return value; };
    return { area: number("Area"), mean: number("Mean"), stdDev: number("StdDev"), min: number("Min"), max: number("Max"), median: number("Median") };
  });
}
const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
function sampleSd(values: number[]) { const mean = avg(values); return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)); }
const fmt = (value: number, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : "—";

export default function Home() {
  const [tab, setTab] = useState<"uniform" | "dose">("uniform");
  const [mode, setMode] = useState(modes[1].value);
  const [rois, setRois] = useState<Roi[]>([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [factor, setFactor] = useState("0.95");
  const [doseRows, setDoseRows] = useState<DoseRow[]>(Array.from({ length: 5 }, () => ({ kv: "", scanTime: "", dose: "", hvl: "" })));
  const result = useMemo(() => {
    if (rois.length !== 5) return null;
    const edgeMean = avg(rois.slice(0, 4).map((r) => r.mean));
    const uniformity = ((rois[4].mean - edgeMean) * 100) / (edgeMean + 1000);
    const noise = (avg(rois.map((r) => r.stdDev)) * 100) / (rois[4].mean + 1000);
    const limits = modes.find((item) => item.value === mode)!;
    return { edgeMean, uniformity, noise, passUniform: uniformity >= limits.min && uniformity <= limits.max, passNoise: noise >= -10 && noise <= 10, limits };
  }, [rois, mode]);
  const doseResult = useMemo(() => {
    const calibration = Number(factor); const parsed = doseRows.map((row) => Object.values(row).map(Number));
    if (!Number.isFinite(calibration) || parsed.some((row) => row.some((v) => !Number.isFinite(v) || v <= 0))) return null;
    const calibratedKv = parsed.map((r) => r[0] * calibration), scanTimes = parsed.map((r) => r[1]), doses = parsed.map((r) => r[2]), hvls = parsed.map((r) => r[3]);
    const metric = (values: number[], limit: number) => ({ mean: avg(values), sd: sampleSd(values), cv: 100 * sampleSd(values) / avg(values), limit });
    return { calibratedKv, kv: metric(calibratedKv, 2), scan: metric(scanTimes, 5), dose: metric(doses, 5), hvlMean: avg(hvls), hvlPass: hvls.every((v) => v > 2.5) };
  }, [doseRows, factor]);
  async function handleFile(file?: File) {
    if (!file) return; setError("");
    if (!file.name.toLowerCase().endsWith(".csv")) { setError("รองรับเฉพาะไฟล์ .csv"); return; }
    if (file.size > 5 * 1024 * 1024) { setError("ไฟล์ต้องมีขนาดไม่เกิน 5 MB"); return; }
    try { setRois(parseCsv(await file.text())); setFileName(file.name); } catch (e) { setRois([]); setFileName(""); setError(e instanceof Error ? e.message : "อ่านไฟล์ไม่สำเร็จ"); }
  }
  function onDrop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setDragging(false); handleFile(event.dataTransfer.files[0]); }
  function updateDose(index: number, field: keyof DoseRow, value: string) { setDoseRows((rows) => rows.map((row, i) => i === index ? { ...row, [field]: value } : row)); }
  return <div className="min-h-screen bg-muted text-foreground">
    <header className="border-b bg-card"><div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4 sm:px-6"><div className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground"><Icon name="flask" size={21}/></div><div><h1 className="text-base font-semibold leading-tight">Noise Uniform Calculator</h1><p className="text-sm text-muted-foreground">ระบบคำนวณคุณภาพภาพทางรังสี</p></div></div></header>
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-6 grid w-full grid-cols-2 rounded-lg bg-secondary p-1 sm:w-[360px]" role="tablist"><button onClick={() => setTab("uniform")} className={`tab ${tab === "uniform" ? "tab-active" : ""}`}>Uniform &amp; Noise</button><button onClick={() => setTab("dose")} className={`tab ${tab === "dose" ? "tab-active" : ""}`}>Dose</button></div>
      {tab === "uniform" ? <div className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <section className="card"><div className="card-header"><h2>นำเข้าข้อมูล ROI</h2><p>อัปโหลดไฟล์ผลการวัดจากเครื่องมือในรูปแบบ CSV</p></div><div className="card-body space-y-5">
          <div><label className="label" htmlFor="mode">โหมดการสแกน</label><select id="mode" value={mode} onChange={(e) => setMode(e.target.value)} className="input">{modes.map((item) => <option key={item.value}>{item.value}</option>)}</select></div>
          <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => inputRef.current?.click()} className={`dropzone ${dragging ? "dropzone-active" : ""}`}><input ref={inputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e: ChangeEvent<HTMLInputElement>) => handleFile(e.target.files?.[0])}/><div className="upload-icon"><Icon name="upload"/></div><p className="font-medium">ลากไฟล์ CSV มาวางที่นี่</p><p className="text-sm text-muted-foreground">หรือคลิกเพื่อเลือกไฟล์ • สูงสุด 5 MB</p></div>
          {error && <div className="alert alert-error"><Icon name="x" size={17}/><span>{error}</span></div>}
          {fileName && <div className="file-row"><Icon name="file"/><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{fileName}</p><p className="text-xs text-muted-foreground">อ่านข้อมูล 5 ตำแหน่งสำเร็จ</p></div><span className="status status-pass"><Icon name="check" size={14}/>พร้อมคำนวณ</span></div>}
          <div className="info"><Icon name="shield" size={18}/><p><strong>ข้อมูลอยู่ในอุปกรณ์ของคุณ</strong><br/><span>การอ่านและคำนวณไฟล์ทำในเบราว์เซอร์ ไม่มีการส่งไฟล์ไปยังเซิร์ฟเวอร์</span></p></div>
        </div></section>
        <section className="card"><div className="card-header"><h2>ผลการคำนวณ</h2><p>{result ? `อ้างอิงเกณฑ์โหมด ${mode}` : "ผลลัพธ์จะแสดงหลังจากอัปโหลดไฟล์"}</p></div><div className="card-body">
          {!result ? <div className="empty"><div className="upload-icon"><Icon name="file"/></div><p>ยังไม่มีข้อมูลสำหรับคำนวณ</p><span>เลือกไฟล์ CSV เพื่อเริ่มต้น</span></div> : <div className="space-y-5"><div className="result-grid"><Result label="Uniformity" value={`${fmt(result.uniformity, 2)}%`} pass={result.passUniform} criteria={result.limits.criteria}/><Result label="Noise" value={`${fmt(result.noise, 2)}%`} pass={result.passNoise} criteria="-10% ถึง 10%"/></div><div className="rounded-lg border"><div className="table-scroll"><table><thead><tr><th>ตำแหน่ง</th><th>Mean (HU)</th><th>SD (HU)</th></tr></thead><tbody>{rois.map((roi, i) => <tr key={positions[i]}><td>{positions[i]}</td><td>{fmt(roi.mean)}</td><td>{fmt(roi.stdDev)}</td></tr>)}</tbody></table></div></div><div className="formula"><p>Mean เฉลี่ย 4 ขอบ <strong>{fmt(result.edgeMean)} HU</strong></p><p>Mean จุดกลาง <strong>{fmt(rois[4].mean)} HU</strong></p></div></div>}
        </div></section>
      </div> : <section className="card"><div className="card-header"><h2>คำนวณ Dose</h2><p>กรอกค่าจากการสแกน 5 ครั้งเพื่อคำนวณ Mean, SD และ %CV</p></div><div className="card-body space-y-6">
        <div className="max-w-xs"><label className="label" htmlFor="factor">Calibration factor ของ dose meter</label><input id="factor" type="number" min="0" step="any" className="input" value={factor} onChange={(e) => setFactor(e.target.value)}/></div>
        <div className="rounded-lg border"><div className="table-scroll"><table className="dose-table"><thead><tr><th>ครั้งที่</th><th>kV</th><th>Scan time (s)</th><th>Dose (mGy)</th><th>HVL (mm Al)</th>{doseResult && <th>kV × factor</th>}</tr></thead><tbody>{doseRows.map((row, i) => <tr key={i}><td>{i + 1}</td>{(["kv", "scanTime", "dose", "hvl"] as const).map((field) => <td key={field}><input aria-label={`${field} ครั้งที่ ${i + 1}`} type="number" min="0" step="any" value={row[field]} onChange={(e) => updateDose(i, field, e.target.value)} placeholder="0.00"/></td>)}{doseResult && <td>{fmt(doseResult.calibratedKv[i])}</td>}</tr>)}</tbody></table></div></div>
        {!doseResult ? <div className="info"><Icon name="shield" size={18}/><p><strong>กรอกข้อมูลให้ครบทั้ง 5 ครั้ง</strong><br/><span>ระบบจะคำนวณผลให้อัตโนมัติเมื่อค่าทุกช่องมากกว่า 0</span></p></div> : <div className="result-grid three"><DoseResult label="kV (ปรับแล้ว)" data={doseResult.kv}/><DoseResult label="Scan time" data={doseResult.scan}/><DoseResult label="Dose" data={doseResult.dose}/></div>}
        {doseResult && <div className={`alert ${doseResult.hvlPass ? "alert-success" : "alert-error"}`}>{doseResult.hvlPass ? <Icon name="check" size={17}/> : <Icon name="x" size={17}/>}HVL เฉลี่ย {fmt(doseResult.hvlMean, 2)} mm Al — {doseResult.hvlPass ? "ผ่านเกณฑ์ทุกครั้ง (> 2.5 mm Al)" : "ไม่ผ่านเกณฑ์"}</div>}
      </div></section>}
    </main><footer className="mx-auto flex max-w-6xl items-center gap-2 px-4 pb-8 text-xs text-muted-foreground sm:px-6"><Icon name="shield" size={14}/> เครื่องมือนี้ช่วยคำนวณผล กรุณาตรวจสอบค่าก่อนนำไปใช้งานทางคลินิก</footer>
  </div>;
}
function Result({ label, value, pass, criteria }: { label: string; value: string; pass: boolean; criteria: string }) { return <div className="result-card"><div className="flex items-center justify-between"><span>{label}</span><span className={`status ${pass ? "status-pass" : "status-fail"}`}>{pass ? <Icon name="check" size={14}/> : <Icon name="x" size={14}/>} {pass ? "ผ่าน" : "ไม่ผ่าน"}</span></div><strong>{value}</strong><small>เกณฑ์ {criteria}</small></div>; }
function DoseResult({ label, data }: { label: string; data: { mean: number; sd: number; cv: number; limit: number } }) { const pass = data.cv <= data.limit; return <div className="result-card"><div className="flex items-center justify-between"><span>{label}</span><span className={`status ${pass ? "status-pass" : "status-fail"}`}>{pass ? "ผ่าน" : "ไม่ผ่าน"}</span></div><strong>{fmt(data.cv, 3)}%</strong><small>Mean {fmt(data.mean)} • SD {fmt(data.sd)} • เกณฑ์ CV ≤ {data.limit}%</small></div>; }
