import "server-only";

import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { geocodePlace, getUserLocation, weatherReportFor } from "../weather";
import { alertWindowText, placeText, weatherText, type WeatherReport } from "@/lib/domain/weather";

/** Clima por WhatsApp: pronóstico (Open-Meteo) y alertas oficiales del SMN. */
export const WEATHER_TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description:
        "Clima actual, pronóstico por hora (próximas 24 h) y de los próximos días, y alertas meteorológicas vigentes del SMN. Sin `place` usa la ubicación guardada del usuario; con `place` consulta otra ciudad.",
      parameters: {
        type: "object",
        properties: {
          place: {
            type: "string",
            description: "Ciudad o lugar si pregunta por otro lado (\"Bariloche\", \"Mar del Plata\"). Omitir para su ubicación.",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

export const WEATHER_TOOL_NAMES = new Set(WEATHER_TOOLS.map((t) => t.function.name));

const schema = z.object({ place: z.string().trim().min(2).max(80).optional() });

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Lo justo para que el modelo conteste, sin polígonos ni ruido. */
const compact = (report: WeatherReport, where: string) => {
  const f = report.forecast;
  const now = new Date();
  return {
    lugar: where,
    actual: f
      ? {
          temperatura: r1(f.current.temperature),
          sensacion: r1(f.current.feelsLike),
          cielo: weatherText(f.current.weatherCode),
          humedad: f.current.humidity,
          vientoKmH: Math.round(f.current.windSpeed),
          rafagasKmH: Math.round(f.current.windGusts),
        }
      : null,
    // Cada 3 horas alcanza para decir "llueve a la tarde".
    proximasHoras: f?.hourly
      .filter((_, i) => i % 3 === 0)
      .map((h) => ({
        hora: h.time.slice(11, 16),
        dia: h.time.slice(0, 10),
        temperatura: Math.round(h.temperature),
        lluviaProb: h.precipProbability,
        cielo: weatherText(h.weatherCode),
      })),
    dias: f?.daily.map((d) => ({
      fecha: d.date,
      cielo: weatherText(d.weatherCode),
      min: Math.round(d.tempMin),
      max: Math.round(d.tempMax),
      lluviaProb: d.precipProbability,
      lluviaMm: r1(d.precipSum),
      rafagasMaxKmH: Math.round(d.windGustsMax),
      uvMax: Math.round(d.uvIndexMax),
    })),
    alertasSMN: report.alerts.map((a) => ({
      alerta: `${a.level} por ${a.event.toLowerCase()}`,
      cuando: alertWindowText(a, now),
      detalle: a.description,
      recomendaciones: a.instructions.slice(0, 4),
    })),
    fuente: report.alerts.length > 0 ? "Pronóstico: Open-Meteo. Alertas: SMN (citar \"Fuente: SMN\")." : "Open-Meteo",
    ...(f ? {} : { aviso: "No pude traer el pronóstico ahora; solo hay alertas." }),
  };
};

export const runWeatherTool = async (uid: string, _name: string, args: unknown): Promise<Record<string, unknown>> => {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join("; ") };

  if (parsed.data.place) {
    const found = await geocodePlace(parsed.data.place).catch(() => null);
    if (!found) return { error: `No encontré "${parsed.data.place}". Pedile que lo escriba de otra forma.` };
    const where = [found.place, found.province, found.country !== "Argentina" ? found.country : null]
      .filter(Boolean)
      .join(", ");
    const report = await weatherReportFor({ ...found, updatedAt: Date.now() });
    return compact(report, where);
  }

  const location = await getUserLocation(uid);
  if (!location) {
    return {
      error: "sin_ubicacion",
      comoSeguir:
        "No tengo su ubicación. Pedile que te mande la ubicación por acá (📎 → Ubicación) o que la active en la app, o que te diga la ciudad.",
    };
  }
  return compact(await weatherReportFor(location), placeText(location));
};
