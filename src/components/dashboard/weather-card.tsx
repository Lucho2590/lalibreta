"use client";

import Link from "next/link";
import { ChevronRight, Droplets, MapPin } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useWeather } from "@/hooks/use-weather";
import { ALERT_STYLE } from "@/components/weather/alert-style";
import { LEVEL_EMOJI, alertWindowText, placeText, weatherEmoji, weatherText } from "@/lib/domain/weather";
import { cn } from "@/lib/utils";

/** En el inicio: el clima de ahora donde estás y, si hay, la alerta del SMN. */
export function WeatherCard() {
  const { data, loading } = useWeather();
  if (loading || !data || data.optOut) return null;

  if (!data.location) {
    return (
      <Link href="/clima" className="block">
        <Card className="rounded-3xl border border-dashed bg-transparent py-3 ring-0 transition hover:bg-muted/30">
          <CardContent className="flex items-center gap-3 text-sm">
            <MapPin className="size-4 shrink-0 text-primary" />
            <span className="flex-1">Activá tu ubicación para ver el clima y recibir alertas del SMN.</span>
            <ChevronRight className="size-4 text-muted-foreground" />
          </CardContent>
        </Card>
      </Link>
    );
  }

  const f = data.forecast;
  const today = f?.daily[0];
  const alert = data.alerts[0];
  if (!f && !alert) return null;

  return (
    <Link href="/clima" className="block">
      <Card className="gap-0 rounded-3xl py-0 transition hover:bg-muted/30">
        {alert && (
          <div className={cn("flex items-center gap-2 px-4 py-2.5 text-sm font-medium ring-1 ring-inset", ALERT_STYLE[alert.level])}>
            <span>{LEVEL_EMOJI[alert.level]}</span>
            <span className="min-w-0 flex-1 truncate">
              Alerta {alert.level} por {alert.event.toLowerCase()}
              <span className="font-normal opacity-80"> · {alertWindowText(alert)}</span>
            </span>
            {data.alerts.length > 1 && <span className="text-xs opacity-80">+{data.alerts.length - 1}</span>}
          </div>
        )}
        {f && (
          <CardContent className="flex items-center gap-3 py-4">
            <span className="text-4xl leading-none" aria-hidden>
              {weatherEmoji(f.current.weatherCode, f.current.isDay)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold tabular-nums">{Math.round(f.current.temperature)}°</span>
                <span className="truncate text-sm text-muted-foreground">{weatherText(f.current.weatherCode)}</span>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                <MapPin className="mr-0.5 inline size-3 align-[-1px]" />
                {placeText(data.location)}
              </div>
            </div>
            {today && (
              <div className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                <div>
                  <span className="font-semibold text-foreground">{Math.round(today.tempMax)}°</span> /{" "}
                  {Math.round(today.tempMin)}°
                </div>
                {today.precipProbability >= 20 && (
                  <div className="flex items-center justify-end gap-0.5">
                    <Droplets className="size-3" /> {today.precipProbability}%
                  </div>
                )}
              </div>
            )}
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </CardContent>
        )}
      </Card>
    </Link>
  );
}
