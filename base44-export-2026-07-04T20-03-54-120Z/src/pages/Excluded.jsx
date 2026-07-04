const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import AppShell from "@/components/mlb/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function Excluded() {
  const [date, setDate] = useState(todayStr());

  const { data, isLoading } = useQuery({
    queryKey: ["excluded", date],
    queryFn: () => db.entities.ExcludedPlayer.filter({ game_date: date }),
  });

  const excluded = data ?? [];

  return (
    <AppShell>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Transparency</div>
          <h1 className="text-3xl font-black tracking-tight">Excluded players</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Anyone the pipeline could not score today, and the exact reason. No silent skips.
          </p>
        </div>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{excluded.length} exclusions on {date}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && <div className="py-8 text-center text-muted-foreground">Loading…</div>}
          {!isLoading && excluded.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">No exclusions recorded for this date.</div>
          )}
          {!isLoading && excluded.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Player</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {excluded.map((x) => (
                    <TableRow key={x.id}>
                      <TableCell className="font-medium">{x.player_name ?? `Player #${x.player_id ?? "—"}`}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{x.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}