export function computePickGrade(pick) {
  const confidence = Number(pick?.confidence ?? 0);
  return { numericGrade: confidence, letterGrade: confidence >= 75 ? "A" : confidence >= 60 ? "B" : confidence >= 45 ? "C" : "D" };
}
export function gradeColorClass(letterGrade) {
  return { A: "bg-emerald-600 text-white", B: "bg-blue-500 text-white", C: "bg-amber-500 text-white", D: "bg-slate-500 text-white" }[letterGrade] ?? "bg-muted text-muted-foreground";
}
