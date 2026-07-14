/**
 * Xero Organisation.Timezone is a Windows-style ID with spaces stripped and
 * uppercased (e.g. "SE Asia Standard Time" → SEASIASTANDARDTIME). Intl needs
 * IANA IDs. Map is Xero XSD enum → CLDR windowsZones territory="001" IANA.
 *
 * @see https://github.com/XeroAPI/XeroAPI-Schemas/.../Timezone.xsd
 */

/** True when `tz` is accepted by Intl.DateTimeFormat. */
export function isIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Xero enum → IANA. Cover every value in Xero's Timezone.xsd so period math
 * never throws on a real org timezone.
 */
const XERO_TO_IANA: Record<string, string> = {
  MOROCCOSTANDARDTIME: "Africa/Casablanca",
  UTC: "Etc/UTC",
  GMTSTANDARDTIME: "Europe/London",
  GREENWICHSTANDARDTIME: "Atlantic/Reykjavik",
  WEUROPESTANDARDTIME: "Europe/Berlin",
  CENTRALEUROPESTANDARDTIME: "Europe/Budapest",
  ROMANCESTANDARDTIME: "Europe/Paris",
  CENTRALEUROPEANSTANDARDTIME: "Europe/Warsaw",
  WCENTRALAFRICASTANDARDTIME: "Africa/Lagos",
  NAMIBIASTANDARDTIME: "Africa/Windhoek",
  JORDANSTANDARDTIME: "Asia/Amman",
  GTBSTANDARDTIME: "Europe/Bucharest",
  MIDDLEEASTSTANDARDTIME: "Asia/Beirut",
  EGYPTSTANDARDTIME: "Africa/Cairo",
  SYRIASTANDARDTIME: "Asia/Damascus",
  EEUROPESTANDARDTIME: "Europe/Chisinau",
  SOUTHAFRICASTANDARDTIME: "Africa/Johannesburg",
  FLESTANDARDTIME: "Europe/Kyiv",
  TURKEYSTANDARDTIME: "Europe/Istanbul",
  ISRAELSTANDARDTIME: "Asia/Jerusalem",
  KALININGRADSTANDARDTIME: "Europe/Kaliningrad",
  LIBYASTANDARDTIME: "Africa/Tripoli",
  ARABICSTANDARDTIME: "Asia/Baghdad",
  ARABSTANDARDTIME: "Asia/Riyadh",
  BELARUSSTANDARDTIME: "Europe/Minsk",
  RUSSIANSTANDARDTIME: "Europe/Moscow",
  EAFRICASTANDARDTIME: "Africa/Nairobi",
  IRANSTANDARDTIME: "Asia/Tehran",
  ARABIANSTANDARDTIME: "Asia/Dubai",
  AZERBAIJANSTANDARDTIME: "Asia/Baku",
  RUSSIATIMEZONE3: "Europe/Samara",
  MAURITIUSSTANDARDTIME: "Indian/Mauritius",
  GEORGIANSTANDARDTIME: "Asia/Tbilisi",
  CAUCASUSSTANDARDTIME: "Asia/Yerevan",
  AFGHANISTANSTANDARDTIME: "Asia/Kabul",
  WESTASIASTANDARDTIME: "Asia/Tashkent",
  EKATERINBURGSTANDARDTIME: "Asia/Yekaterinburg",
  PAKISTANSTANDARDTIME: "Asia/Karachi",
  INDIASTANDARDTIME: "Asia/Kolkata",
  SRILANKASTANDARDTIME: "Asia/Colombo",
  NEPALSTANDARDTIME: "Asia/Kathmandu",
  CENTRALASIASTANDARDTIME: "Asia/Almaty",
  BANGLADESHSTANDARDTIME: "Asia/Dhaka",
  NCENTRALASIASTANDARDTIME: "Asia/Novosibirsk",
  MYANMARSTANDARDTIME: "Asia/Yangon",
  /** (UTC+07:00) Bangkok, Hanoi, Jakarta */
  SEASIASTANDARDTIME: "Asia/Bangkok",
  NORTHASIASTANDARDTIME: "Asia/Krasnoyarsk",
  CHINASTANDARDTIME: "Asia/Shanghai",
  NORTHASIAEASTSTANDARDTIME: "Asia/Irkutsk",
  SINGAPORESTANDARDTIME: "Asia/Singapore",
  WAUSTRALIASTANDARDTIME: "Australia/Perth",
  TAIPEISTANDARDTIME: "Asia/Taipei",
  ULAANBAATARSTANDARDTIME: "Asia/Ulaanbaatar",
  TOKYOSTANDARDTIME: "Asia/Tokyo",
  KOREASTANDARDTIME: "Asia/Seoul",
  YAKUTSKSTANDARDTIME: "Asia/Yakutsk",
  CENAUSTRAALIASTANDARDTIME: "Australia/Adelaide",
  CENAUSTRALIASTANDARDTIME: "Australia/Adelaide",
  AUSCENTRALSTANDARDTIME: "Australia/Darwin",
  EAUSTRALIASTANDARDTIME: "Australia/Brisbane",
  AUSEASTERNSTANDARDTIME: "Australia/Sydney",
  WESTPACIFICSTANDARDTIME: "Pacific/Port_Moresby",
  TASMANIASTANDARDTIME: "Australia/Hobart",
  MAGADANSTANDARDTIME: "Asia/Magadan",
  VLADIVOSTOKSTANDARDTIME: "Asia/Vladivostok",
  RUSSIATIMEZONE10: "Asia/Srednekolymsk",
  CENTRALPACIFICSTANDARDTIME: "Pacific/Guadalcanal",
  RUSSIATIMEZONE11: "Asia/Kamchatka",
  NEWZEALANDSTANDARDTIME: "Pacific/Auckland",
  UTC12: "Etc/GMT-12",
  FIJISTANDARDTIME: "Pacific/Fiji",
  KAMCHATKASTANDARDTIME: "Asia/Kamchatka",
  TONGASTANDARDTIME: "Pacific/Tongatapu",
  SAMOASTANDARDTIME: "Pacific/Apia",
  LINEISLANDSSTANDARDTIME: "Pacific/Kiritimati",
  AZORESSTANDARDTIME: "Atlantic/Azores",
  CABOVERDESTANDARDTIME: "Atlantic/Cape_Verde",
  UTC02: "Etc/GMT+2",
  MIDATLANTICSTANDARDTIME: "Atlantic/South_Georgia",
  ESOUTHAMERICASTANDARDTIME: "America/Sao_Paulo",
  ARGENTINASTANDARDTIME: "America/Argentina/Buenos_Aires",
  SAEASTERNSTANDARDTIME: "America/Cayenne",
  GREENLANDSTANDARDTIME: "America/Nuuk",
  MONTEVIDEOSTANDARDTIME: "America/Montevideo",
  BAHIASTANDARDTIME: "America/Bahia",
  NEWFOUNDLANDSTANDARDTIME: "America/St_Johns",
  PARAGUAYSTANDARDTIME: "America/Asuncion",
  ATLANTICSTANDARDTIME: "America/Halifax",
  CENTRALBRAZILIANSTANDARDTIME: "America/Cuiaba",
  SAWESTERNSTANDARDTIME: "America/La_Paz",
  PACIFICSASTANDARDTIME: "America/Santiago",
  VENEZUELASTANDARDTIME: "America/Caracas",
  SAPACIFICSTANDARDTIME: "America/Bogota",
  EASTERNSTANDARDTIME: "America/New_York",
  USEASTERNSTANDARDTIME: "America/Indiana/Indianapolis",
  CENTRALAMERICASTANDARDTIME: "America/Guatemala",
  CENTRALSTANDARDTIME: "America/Chicago",
  CENTRALSTANDARDTIMEMEXICO: "America/Mexico_City",
  CANADACENTRALSTANDARDTIME: "America/Regina",
  USMOUNTAINSTANDARDTIME: "America/Phoenix",
  MOUNTAINSTANDARDTIMEMEXICO: "America/Chihuahua",
  MOUNTAINSTANDARDTIME: "America/Denver",
  PACIFICSTANDARDTIMEMEXICO: "America/Tijuana",
  PACIFICSTANDARDTIME: "America/Los_Angeles",
  ALASKANSTANDARDTIME: "America/Anchorage",
  HAWAIIANSTANDARDTIME: "Pacific/Honolulu",
  UTC11: "Etc/GMT+11",
  DATELINESTANDARDTIME: "Etc/GMT+12",
};

/**
 * Convert a Xero (or already-IANA) timezone string to an IANA ID safe for Intl.
 * Unknown values fall back to UTC so period resolution never throws.
 */
export function toIanaTimezone(tz: string): string {
  const trimmed = tz.trim();
  if (!trimmed) return "UTC";
  if (isIanaTimezone(trimmed)) return trimmed;

  const mapped = XERO_TO_IANA[trimmed.toUpperCase()];
  if (mapped && isIanaTimezone(mapped)) return mapped;

  return "UTC";
}
