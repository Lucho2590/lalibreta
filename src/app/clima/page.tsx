"use client";

import { useState } from "react";
import { CloudSun, Droplets, Loader2, LocateFixed, MapPin, MapPinOff, Wind } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useWeather } from "@/hooks/use-weather";
import { ALERT_STYLE } from "@/components/weather/alert-style";
import { forgetLocation, isPermissionDenied, placeLabel, pushLocation } from "@/lib/pwa/location-client";
import {
  LEVEL_EMOJI,
  alertWindowText,
  placeText,
  weatherEmoji,
  weatherText,
  type DailyWeather,
  type WeatherAlertSummary,
} from "@/lib/domain/weather";
import { cn } from "@/lib/utils";

const TZ = "America/Argentina/Buenos_Aires";
const ymd = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

const dayName = (date: string) => {
  const now = new Date();
  if (date === ymd(now)) return "Hoy";
  if (date === ymd(new Date(now.getTime() + 86_400_000))) return "Mañana";
  const label = new Intl.DateTimeFormat("es-AR", { timeZone: TZ, weekday: "long" }).format(
    new Date(`${date}T12:00:00-03:00`),
  );
  return label.charAt(0).toUpperCase() + label.slice(1);
};

function AlertCard({ alert }: { alert: WeatherAlertSummary }) {
  return (
    <div className={cn("space-y-2 rounded-3xl p-4 ring-1", ALERT_STYLE[alert.level])}>
      <div className="flex items-start gap-2">
        <span className="text-lg leading-none">{LEVEL_EMOJI[alert.level]}</span>
        <div className="min-w-0">
          <div className="font-semibold">
            Alerta {alert.level} por {alert.event.toLowerCase()}
          </div>
          <div className="text-xs opacity-80">{alertWindowText(alert)}</div>
        </div>
      </div>
      {alert.description && <p className="text-sm">{alert.description}</p>}
      {alert.instructions.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {alert.instructions.map((tip, i) => (
            <li key={i}>{tip}</li>
          ))}
        </ul>
      )}
      <a
        href="https://www.smn.gob.ar/alertas"
        target="_blank"
        rel="noreferrer"
        className="inline-block text-xs underline underline-offset-2 opacity-80"
      >
        Fuente: SMN
      </a>
    </div>
  );
}

function DayRow({ day }: { day: DailyWeather }) {
  return (
    <li className="flex items-center gap-3 py-2.5 text-sm">
      <span className="w-20 shrink-0 font-medium">{dayName(day.date)}</span>
      <span className="text-xl leading-none" aria-hidden>
        {weatherEmoji(day.weatherCode)}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{weatherText(day.weatherCode)}</span>
      {day.precipProbability >= 20 && (
        <span className="flex shrink-0 items-center gap-0.5 text-xs text-sky-600 dark:text-sky-400">
          <Droplets className="size-3" />
          {day.precipProbability}%
        </span>
      )}
      <span className="w-16 shrink-0 text-right tabular-nums">
        <span className="font-semibold">{Math.round(day.tempMax)}°</span>{" "}
        <span className="text-muted-foreground">{Math.round(day.tempMin)}°</span>
      </span>
    </li>
  );
}

export default function ClimaPage() {
  const { data, loading } = useWeather();
  const [busy, setBusy] = useState<"locate" | "forget" | null>(null);

  const locate = async () => {
    setBusy("locate");
    try {
      const res = await pushLocation(true);
      toast.success(`📍 ${res.location ? placeLabel(res.location) : "Ubicación actualizada"}`);
    } catch (err) {
      toast.error(
        isPermissionDenied(err)
          ? "El navegador tiene bloqueada la ubicación para La Libreta. Habilitala en los permisos del sitio y probá de nuevo."
          : "No pude obtener tu ubicación. Probá de nuevo en un ratito.",
      );
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    setBusy("forget");
    try {
      await forgetLocation();
      toast.success("Listo, ya no usamos tu ubicación.");
    } catch {
      toast.error("No se pudo completar");
    } finally {
      setBusy(null);
    }
  };

  const f = data?.forecast;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <CloudSun className="size-6 text-primary" /> Clima
          </h1>
          {data?.location && (
            <p className="truncate text-sm text-muted-foreground">
              <MapPin className="mr-0.5 inline size-3.5 align-[-2px]" />
              {placeText(data.location)}
            </p>
          )}
        </div>
        {data?.location && (
          <Button variant="outline" size="sm" className="rounded-xl" onClick={locate} disabled={!!busy}>
            {busy === "locate" ? <Loader2 className="size-4 animate-spin" /> : <LocateFixed className="size-4" />}
            Actualizar
          </Button>
        )}
      </div>

      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-32 rounded-3xl" />
          <Skeleton className="h-48 rounded-3xl" />
        </div>
      )}

      {!loading && data && !data.location && (
        <Card className="rounded-3xl">
          <CardContent className="space-y-3 text-sm">
            <p>
              {data.optOut
                ? "Elegiste no usar tu ubicación. Si querés volver a ver el clima y recibir alertas del SMN, activala de nuevo."
                : "Activá tu ubicación para ver el clima de donde estás y recibir las alertas del SMN (tormentas, viento, calor extremo) de tu zona."}
            </p>
            <p className="text-muted-foreground">
              Usamos tu ubicación aproximada (~1 km) y solo para el clima. También podés mandársela al bot por WhatsApp
              (📎 → Ubicación).
            </p>
            <Button onClick={locate} disabled={!!busy} className="rounded-xl">
              {busy === "locate" ? <Loader2 className="size-4 animate-spin" /> : <MapPin className="size-4" />}
              Activar ubicación
            </Button>
          </CardContent>
        </Card>
      )}

      {!loading && !data && (
        <p className="text-sm text-muted-foreground">No pude traer el clima ahora. Probá de nuevo en un rato.</p>
      )}

      {data?.location && (
        <>
          {data.alerts.length > 0 && (
            <section className="space-y-3">
              {data.alerts.map((a) => (
                <AlertCard key={a.id} alert={a} />
              ))}
            </section>
          )}

          {f && (
            <Card className="rounded-3xl">
              <CardContent className="flex items-center gap-4">
                <span className="text-6xl leading-none" aria-hidden>
                  {weatherEmoji(f.current.weatherCode, f.current.isDay)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-4xl font-bold tabular-nums">{Math.round(f.current.temperature)}°</div>
                  <div className="text-sm">{weatherText(f.current.weatherCode)}</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span>Sensación {Math.round(f.current.feelsLike)}°</span>
                    <span>Humedad {f.current.humidity}%</span>
                    <span className="flex items-center gap-0.5">
                      <Wind className="size-3" /> {Math.round(f.current.windSpeed)} km/h
                      {f.current.windGusts >= 40 && ` (ráfagas ${Math.round(f.current.windGusts)})`}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {f && f.hourly.length > 0 && (
            <Card className="rounded-3xl">
              <CardHeader className="pb-0">
                <CardTitle className="text-sm font-semibold">Próximas horas</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="-mx-1 flex gap-1 overflow-x-auto pb-1">
                  {f.hourly.map((h) => (
                    <li
                      key={h.time}
                      className="flex w-14 shrink-0 flex-col items-center gap-1 rounded-xl py-1.5 text-xs"
                    >
                      <span className="text-muted-foreground">{h.time.slice(11, 13)} h</span>
                      <span className="text-lg leading-none" aria-hidden>
                        {weatherEmoji(h.weatherCode, Number(h.time.slice(11, 13)) >= 7 && Number(h.time.slice(11, 13)) < 20)}
                      </span>
                      <span className="font-semibold tabular-nums">{Math.round(h.temperature)}°</span>
                      <span
                        className={cn(
                          "tabular-nums",
                          h.precipProbability >= 30 ? "text-sky-600 dark:text-sky-400" : "text-transparent",
                        )}
                      >
                        {h.precipProbability}%
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {f && (
            <Card className="rounded-3xl">
              <CardHeader className="pb-0">
                <CardTitle className="text-sm font-semibold">Próximos días</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {f.daily.map((d) => (
                    <DayRow key={d.date} day={d} />
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {!f && <p className="text-sm text-muted-foreground">No pude traer el pronóstico ahora.</p>}

          <div className="flex flex-col items-start gap-2 text-xs text-muted-foreground">
            <span>Pronóstico: Open-Meteo · Alertas: Servicio Meteorológico Nacional (SMN)</span>
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 h-8 rounded-xl text-xs text-muted-foreground"
              onClick={forget}
              disabled={!!busy}
            >
              {busy === "forget" ? <Loader2 className="size-3.5 animate-spin" /> : <MapPinOff className="size-3.5" />}
              Dejar de usar mi ubicación
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
