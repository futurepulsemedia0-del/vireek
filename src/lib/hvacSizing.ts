/**
 * HVAC load + duct sizing engine for quotes (pure functions, no I/O).
 *
 *  - computeLoad():    Manual J-based whole-house heating / cooling load ESTIMATE
 *  - manual S window:  see ahriMatchup.ts (equipment sizing against these loads)
 *  - computeDuctDesign(): equal-friction duct sizing (Manual D style method)
 *
 * IMPORTANT: this is a fast, transparent estimating worksheet built on the published
 * ACCA/ASHRAE heat-transfer fundamentals. It is NOT an ACCA-approved Manual J
 * report. Where a permit office requires one, run approved software and use
 * this as the sales-stage estimate. Every constant that is an engineering
 * assumption is named and exported so it can be reviewed or tuned in one place.
 */

// ============================================================
// TYPES
// ============================================================

export type HumidityClass = 'dry' | 'moderate' | 'humid';
export type CeilingType = 'attic' | 'cathedral' | 'conditioned_above';
export type FloorType = 'slab' | 'crawlspace' | 'basement' | 'over_garage' | 'conditioned_below';
export type ExteriorColor = 'light' | 'medium' | 'dark';
export type WindowShading = 'none' | 'blinds' | 'drapes' | 'exterior';
export type AirTightness = 'tight' | 'average' | 'loose';
export type VentilationRecovery = 'none' | 'hrv' | 'erv';
export type DuctLocation = 'conditioned' | 'basement' | 'crawlspace' | 'attic' | 'attic_leaky';

export interface WindowAreas {
  n: number;
  e: number;
  s: number;
  w: number;
}

export interface HvacLoadInputs {
  // design conditions (deg F)
  outdoorSummerDb: number;
  outdoorWinterDb: number;
  indoorSummerDb: number;
  indoorWinterDb: number;
  humidity: HumidityClass;
  elevationFt: number;
  // building
  conditionedAreaSqft: number;
  ceilingHeightFt: number;
  stories: 1 | 2 | 3;
  /** Long side / short side of the footprint. */
  aspectRatio: number;
  /** When set, replaces the wall area estimated from the footprint. */
  exteriorWallAreaOverrideSqft: number | null;
  // envelope
  wallR: number;
  ceilingR: number;
  floorR: number;
  ceilingType: CeilingType;
  floorType: FloorType;
  slabEdgeInsulated: boolean;
  exteriorColor: ExteriorColor;
  windowAreaSqft: WindowAreas;
  windowU: number;
  windowShgc: number;
  windowShading: WindowShading;
  doorAreaSqft: number;
  // air + internal
  airTightness: AirTightness;
  ventilationCfm: number;
  ventilationRecovery: VentilationRecovery;
  occupants: number;
  applianceSensibleBtuh: number;
  ductLocation: DuctLocation;
}

export interface LoadRow {
  key: string;
  label: string;
  coolingBtuh: number;
  heatingBtuh: number;
}

export interface LoadResult {
  rows: LoadRow[];
  cooling: {
    sensibleBtuh: number;
    latentBtuh: number;
    totalBtuh: number;
    sensibleHeatRatio: number;
    tons: number;
  };
  heating: { totalBtuh: number };
  metrics: {
    coolingSqftPerTon: number;
    coolingBtuhPerSqft: number;
    heatingBtuhPerSqft: number;
    windowToWallRatio: number;
    infiltrationCfmCooling: number;
    infiltrationCfmHeating: number;
    grossWallAreaSqft: number;
    netWallAreaSqft: number;
    perimeterFt: number;
  };
  warnings: string[];
}

// ============================================================
// ENGINEERING CONSTANTS (named, reviewable)
// ============================================================

export const SENSIBLE_AIR_FACTOR = 1.08; // Btu/h per cfm per degF at sea level
export const LATENT_AIR_FACTOR = 0.68; // Btu/h per cfm per grain/lb at sea level
export const PERSON_SENSIBLE_BTUH = 230;
export const PERSON_LATENT_BTUH = 200;

/** Humidity-ratio difference, outdoor minus indoor, at the cooling design condition (grains/lb). */
export const HUMIDITY_GRAINS: Record<HumidityClass, number> = { dry: 25, moderate: 45, humid: 65 };

/** Natural air changes per hour, heating season. Cooling uses COOLING_INFILTRATION_FACTOR of it. */
export const AIR_CHANGES_PER_HOUR: Record<AirTightness, number> = { tight: 0.25, average: 0.5, loose: 0.9 };
export const COOLING_INFILTRATION_FACTOR = 0.7;

/** Extra degF added to the outdoor-indoor difference for sun-exposed opaque walls. */
export const WALL_SOLAR_ADDER_F: Record<ExteriorColor, number> = { light: 0, medium: 6, dark: 12 };
/** Ceiling/roof sun adder over outdoor temperature (degF): attic air or roof surface. */
export const CEILING_SOLAR_ADDER_F: Record<CeilingType, number> = { attic: 25, cathedral: 35, conditioned_above: 0 };

/**
 * Coincident peak solar heat gain per ft2 of glass at SHGC 1.0 (Btu/h), simplified
 * and rounded from ASHRAE Fundamentals-style tables for ~40 deg N. Planning values,
 * not a substitute for room-by-room time-of-day analysis.
 */
export const SOLAR_GAIN_BTUH_PER_FT2: WindowAreas = { n: 30, e: 90, s: 75, w: 130 };
/** Interior/exterior shading attenuation multiplier on solar gain. */
export const SHADING_FACTOR: Record<WindowShading, number> = { none: 1, blinds: 0.7, drapes: 0.6, exterior: 0.4 };

export const DOOR_U = 0.35;
/** Slab-edge heat-loss factor, Btu/h per linear ft per degF. */
export const SLAB_EDGE_F: { uninsulated: number; insulated: number } = { uninsulated: 0.73, insulated: 0.5 };
/** Fraction of the indoor-outdoor difference seen by a floor over each buffer space. */
export const FLOOR_BUFFER_FACTOR_HEATING: Record<'crawlspace' | 'basement' | 'over_garage', number> = {
  crawlspace: 0.5,
  basement: 0.3,
  over_garage: 0.7,
};
export const OVER_GARAGE_COOLING_FACTOR = 0.5;

/** Fraction of sensible load lost/gained in the ducts, by duct location (R-6, sealed unless stated). */
export const DUCT_LOSS_FRACTION: Record<DuctLocation, number> = {
  conditioned: 0,
  basement: 0.04,
  crawlspace: 0.08,
  attic: 0.13,
  attic_leaky: 0.25,
};
export const DUCT_HEATING_FACTOR = 0.8;

export const RECOVERY_SENSIBLE_EFFECTIVENESS: Record<VentilationRecovery, number> = { none: 0, hrv: 0.65, erv: 0.65 };
export const RECOVERY_LATENT_EFFECTIVENESS: Record<VentilationRecovery, number> = { none: 0, hrv: 0, erv: 0.5 };

export const SOLAR_WARNING_WINDOW_TO_WALL = 0.3;

// ============================================================
// SMALL HELPERS
// ============================================================

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const round0 = (n: number): number => Math.round(n);

/** Air density ratio vs sea level (standard atmosphere). */
export function airDensityRatio(elevationFt: number): number {
  const ratio = Math.pow(1 - 6.8754e-6 * elevationFt, 5.2559);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** ASHRAE 62.2 whole-house ventilation airflow: 0.03 cfm/ft2 + 7.5 cfm per (bedrooms + 1). */
export function ashrae622Cfm(conditionedAreaSqft: number, bedrooms: number): number {
  if (!isNum(conditionedAreaSqft) || !isNum(bedrooms) || conditionedAreaSqft <= 0 || bedrooms < 0) return 0;
  return round0(0.03 * conditionedAreaSqft + 7.5 * (Math.floor(bedrooms) + 1));
}

export function formatBtuh(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} Btu/h`;
}

export function formatTons(btuh: number): string {
  return `${(btuh / 12000).toFixed(1)} ton`;
}

// ============================================================
// DEFAULTS + VALIDATION
// ============================================================

export function defaultLoadInputs(): HvacLoadInputs {
  return {
    outdoorSummerDb: 95,
    outdoorWinterDb: 20,
    indoorSummerDb: 75,
    indoorWinterDb: 70,
    humidity: 'moderate',
    elevationFt: 0,
    conditionedAreaSqft: 2000,
    ceilingHeightFt: 8,
    stories: 1,
    aspectRatio: 1.5,
    exteriorWallAreaOverrideSqft: null,
    wallR: 13,
    ceilingR: 30,
    floorR: 11,
    ceilingType: 'attic',
    floorType: 'slab',
    slabEdgeInsulated: false,
    exteriorColor: 'medium',
    windowAreaSqft: { n: 60, e: 60, s: 60, w: 60 },
    windowU: 0.35,
    windowShgc: 0.3,
    windowShading: 'blinds',
    doorAreaSqft: 40,
    airTightness: 'average',
    ventilationCfm: 0,
    ventilationRecovery: 'none',
    occupants: 4,
    applianceSensibleBtuh: 1200,
    ductLocation: 'attic',
  };
}

export type LoadFieldErrors = Partial<Record<string, string>>;

function range(errors: LoadFieldErrors, key: string, value: unknown, min: number, max: number, label: string): void {
  if (!isNum(value) || value < min || value > max) errors[key] = `${label} must be between ${min} and ${max}.`;
}

/** Field-keyed errors; an empty object means the inputs can be calculated. */
export function validateLoadInputs(i: HvacLoadInputs): LoadFieldErrors {
  const e: LoadFieldErrors = {};
  range(e, 'outdoorSummerDb', i.outdoorSummerDb, 60, 130, 'Summer outdoor design temperature');
  range(e, 'outdoorWinterDb', i.outdoorWinterDb, -40, 60, 'Winter outdoor design temperature');
  range(e, 'indoorSummerDb', i.indoorSummerDb, 68, 82, 'Summer indoor temperature');
  range(e, 'indoorWinterDb', i.indoorWinterDb, 60, 76, 'Winter indoor temperature');
  range(e, 'elevationFt', i.elevationFt, -300, 14000, 'Elevation');
  range(e, 'conditionedAreaSqft', i.conditionedAreaSqft, 200, 20000, 'Conditioned area');
  range(e, 'ceilingHeightFt', i.ceilingHeightFt, 6, 20, 'Ceiling height');
  range(e, 'aspectRatio', i.aspectRatio, 1, 4, 'Footprint aspect ratio');
  range(e, 'wallR', i.wallR, 1, 60, 'Wall R-value');
  range(e, 'ceilingR', i.ceilingR, 1, 80, 'Ceiling R-value');
  range(e, 'floorR', i.floorR, 1, 60, 'Floor R-value');
  range(e, 'windowU', i.windowU, 0.1, 1.5, 'Window U-factor');
  range(e, 'windowShgc', i.windowShgc, 0.05, 0.95, 'Window SHGC');
  range(e, 'doorAreaSqft', i.doorAreaSqft, 0, 400, 'Door area');
  range(e, 'occupants', i.occupants, 0, 40, 'Occupants');
  range(e, 'ventilationCfm', i.ventilationCfm, 0, 2000, 'Ventilation airflow');
  range(e, 'applianceSensibleBtuh', i.applianceSensibleBtuh, 0, 20000, 'Appliance gains');
  if (![1, 2, 3].includes(i.stories)) e.stories = 'Stories must be 1, 2 or 3.';
  if (i.exteriorWallAreaOverrideSqft !== null) {
    range(e, 'exteriorWallAreaOverrideSqft', i.exteriorWallAreaOverrideSqft, 100, 20000, 'Exterior wall area');
  }
  for (const k of ['n', 'e', 's', 'w'] as const) {
    range(e, `windowArea_${k}`, i.windowAreaSqft?.[k], 0, 2000, `${k.toUpperCase()} window area`);
  }
  if (isNum(i.outdoorSummerDb) && isNum(i.indoorSummerDb) && i.outdoorSummerDb <= i.indoorSummerDb) {
    e.outdoorSummerDb = 'Summer outdoor design temperature must be higher than the indoor setpoint.';
  }
  if (isNum(i.outdoorWinterDb) && isNum(i.indoorWinterDb) && i.outdoorWinterDb >= i.indoorWinterDb) {
    e.outdoorWinterDb = 'Winter outdoor design temperature must be lower than the indoor setpoint.';
  }
  return e;
}

// ============================================================
// LOAD CALCULATION
// ============================================================

/** Throws RangeError for inputs that fail validateLoadInputs(): callers validate first. */
export function computeLoad(i: HvacLoadInputs): LoadResult {
  const errors = validateLoadInputs(i);
  if (Object.keys(errors).length > 0) throw new RangeError(`Invalid load inputs: ${Object.keys(errors).join(', ')}`);

  const warnings: string[] = [];
  const rho = airDensityRatio(i.elevationFt);
  const sens = SENSIBLE_AIR_FACTOR * rho;
  const lat = LATENT_AIR_FACTOR * rho;

  const dtCool = i.outdoorSummerDb - i.indoorSummerDb;
  const dtHeat = i.indoorWinterDb - i.outdoorWinterDb;

  // ----- geometry -----
  const footprint = i.conditionedAreaSqft / i.stories;
  const longSide = Math.sqrt(footprint * i.aspectRatio);
  const shortSide = footprint / longSide;
  const perimeter = 2 * (longSide + shortSide);
  const grossWall = i.exteriorWallAreaOverrideSqft ?? perimeter * i.ceilingHeightFt * i.stories;
  const windowTotal = sum([i.windowAreaSqft.n, i.windowAreaSqft.e, i.windowAreaSqft.s, i.windowAreaSqft.w]);
  const netWall = Math.max(0, grossWall - windowTotal - i.doorAreaSqft);
  const windowToWall = grossWall > 0 ? windowTotal / grossWall : 0;
  const volume = i.conditionedAreaSqft * i.ceilingHeightFt;
  const ceilingArea = i.ceilingType === 'conditioned_above' ? 0 : footprint;

  if (windowTotal + i.doorAreaSqft > grossWall) {
    warnings.push('Window and door area exceeds the exterior wall area. Check the wall area override or window sizes.');
  }
  if (windowToWall > SOLAR_WARNING_WINDOW_TO_WALL) {
    warnings.push('Window area is above 30% of the wall area, so solar gain will dominate the cooling load.');
  }

  // ----- walls -----
  const wallU = 1 / i.wallR;
  const wallCooling = wallU * netWall * (dtCool + WALL_SOLAR_ADDER_F[i.exteriorColor]);
  const wallHeating = wallU * netWall * dtHeat;

  // ----- doors -----
  const doorCooling = DOOR_U * i.doorAreaSqft * (dtCool + WALL_SOLAR_ADDER_F[i.exteriorColor]);
  const doorHeating = DOOR_U * i.doorAreaSqft * dtHeat;

  // ----- windows -----
  const windowConductionCooling = i.windowU * windowTotal * dtCool;
  const windowConductionHeating = i.windowU * windowTotal * dtHeat;
  const solarCooling = sum(
    (['n', 'e', 's', 'w'] as const).map(
      (k) => i.windowAreaSqft[k] * i.windowShgc * SOLAR_GAIN_BTUH_PER_FT2[k] * SHADING_FACTOR[i.windowShading],
    ),
  );

  // ----- ceiling / roof -----
  const ceilingU = 1 / i.ceilingR;
  const ceilingCooling = ceilingU * ceilingArea * (dtCool + CEILING_SOLAR_ADDER_F[i.ceilingType]);
  const ceilingHeating = ceilingU * ceilingArea * dtHeat;

  // ----- floor -----
  const floorU = 1 / i.floorR;
  let floorCooling = 0;
  let floorHeating = 0;
  if (i.floorType === 'slab') {
    const f = i.slabEdgeInsulated ? SLAB_EDGE_F.insulated : SLAB_EDGE_F.uninsulated;
    floorHeating = f * perimeter * dtHeat;
  } else if (i.floorType === 'crawlspace' || i.floorType === 'basement' || i.floorType === 'over_garage') {
    floorHeating = floorU * footprint * dtHeat * FLOOR_BUFFER_FACTOR_HEATING[i.floorType];
    if (i.floorType === 'over_garage') floorCooling = floorU * footprint * dtCool * OVER_GARAGE_COOLING_FACTOR;
  }

  // ----- infiltration -----
  const achHeating = AIR_CHANGES_PER_HOUR[i.airTightness];
  const cfmHeating = (achHeating * volume) / 60;
  const cfmCooling = cfmHeating * COOLING_INFILTRATION_FACTOR;
  const infilCoolingSensible = sens * cfmCooling * dtCool;
  const infilHeating = sens * cfmHeating * dtHeat;
  const grains = HUMIDITY_GRAINS[i.humidity];
  const infilLatent = lat * cfmCooling * grains;

  // ----- mechanical ventilation -----
  const ventSensEff = RECOVERY_SENSIBLE_EFFECTIVENESS[i.ventilationRecovery];
  const ventLatEff = RECOVERY_LATENT_EFFECTIVENESS[i.ventilationRecovery];
  const ventCoolingSensible = sens * i.ventilationCfm * dtCool * (1 - ventSensEff);
  const ventHeating = sens * i.ventilationCfm * dtHeat * (1 - ventSensEff);
  const ventLatent = lat * i.ventilationCfm * grains * (1 - ventLatEff);

  // ----- internal gains -----
  const peopleSensible = i.occupants * PERSON_SENSIBLE_BTUH;
  const peopleLatent = i.occupants * PERSON_LATENT_BTUH;
  const internalSensible = peopleSensible + i.applianceSensibleBtuh;

  // ----- ducts -----
  const baseCoolingSensible =
    wallCooling + doorCooling + windowConductionCooling + solarCooling + ceilingCooling + floorCooling +
    infilCoolingSensible + ventCoolingSensible + internalSensible;
  const baseHeating =
    wallHeating + doorHeating + windowConductionHeating + ceilingHeating + floorHeating + infilHeating + ventHeating;
  const ductFraction = DUCT_LOSS_FRACTION[i.ductLocation];
  const ductCooling = baseCoolingSensible * ductFraction;
  const ductHeating = baseHeating * ductFraction * DUCT_HEATING_FACTOR;

  const sensibleCooling = baseCoolingSensible + ductCooling;
  const latentCooling = infilLatent + ventLatent + peopleLatent;
  const totalCooling = sensibleCooling + latentCooling;
  const totalHeating = baseHeating + ductHeating;

  const rows: LoadRow[] = [
    { key: 'walls', label: 'Walls', coolingBtuh: wallCooling, heatingBtuh: wallHeating },
    { key: 'windows', label: 'Windows (conduction)', coolingBtuh: windowConductionCooling, heatingBtuh: windowConductionHeating },
    { key: 'solar', label: 'Windows (solar gain)', coolingBtuh: solarCooling, heatingBtuh: 0 },
    { key: 'doors', label: 'Doors', coolingBtuh: doorCooling, heatingBtuh: doorHeating },
    { key: 'ceiling', label: 'Ceiling / roof', coolingBtuh: ceilingCooling, heatingBtuh: ceilingHeating },
    { key: 'floor', label: 'Floor', coolingBtuh: floorCooling, heatingBtuh: floorHeating },
    { key: 'infiltration', label: 'Air leakage', coolingBtuh: infilCoolingSensible + infilLatent, heatingBtuh: infilHeating },
    { key: 'ventilation', label: 'Mechanical ventilation', coolingBtuh: ventCoolingSensible + ventLatent, heatingBtuh: ventHeating },
    { key: 'internal', label: 'People and appliances', coolingBtuh: internalSensible + peopleLatent, heatingBtuh: 0 },
    { key: 'ducts', label: 'Duct losses / gains', coolingBtuh: ductCooling, heatingBtuh: ductHeating },
  ].map((r) => ({ ...r, coolingBtuh: round0(r.coolingBtuh), heatingBtuh: round0(r.heatingBtuh) }));

  const totalCoolingR = round0(totalCooling);
  const sensibleR = round0(sensibleCooling);
  const sqftPerTon = totalCooling > 0 ? (i.conditionedAreaSqft / totalCooling) * 12000 : 0;

  if (sqftPerTon > 0 && sqftPerTon < 350) {
    warnings.push('Cooling load is unusually high for the floor area (under 350 ft2 per ton). Re-check windows, ducts and air leakage.');
  }
  if (sqftPerTon > 2200) {
    warnings.push('Cooling load is unusually low for the floor area (over 2,200 ft2 per ton). Re-check the inputs.');
  }
  if (totalHeating <= 0) warnings.push('Heating load calculated as zero or negative. Re-check the design temperatures.');

  return {
    rows,
    cooling: {
      sensibleBtuh: sensibleR,
      latentBtuh: round0(latentCooling),
      totalBtuh: totalCoolingR,
      sensibleHeatRatio: totalCooling > 0 ? Math.round((sensibleCooling / totalCooling) * 100) / 100 : 0,
      tons: Math.round((totalCooling / 12000) * 100) / 100,
    },
    heating: { totalBtuh: round0(Math.max(0, totalHeating)) },
    metrics: {
      coolingSqftPerTon: round0(sqftPerTon),
      coolingBtuhPerSqft: Math.round((totalCooling / i.conditionedAreaSqft) * 10) / 10,
      heatingBtuhPerSqft: Math.round((totalHeating / i.conditionedAreaSqft) * 10) / 10,
      windowToWallRatio: Math.round(windowToWall * 100) / 100,
      infiltrationCfmCooling: round0(cfmCooling),
      infiltrationCfmHeating: round0(cfmHeating),
      grossWallAreaSqft: round0(grossWall),
      netWallAreaSqft: round0(netWall),
      perimeterFt: round0(perimeter),
    },
    warnings,
  };
}

// ============================================================
// DUCT SIZING (equal-friction method)
// ============================================================

export const STANDARD_ROUND_SIZES_IN = [4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30];
export const VELOCITY_LIMITS_FPM = { trunk: 900, branch: 750, return: 700 } as const;
export const DESIGN_FRICTION_RANGE = { min: 0.06, max: 0.15 } as const; // in.wc per 100 ft
export const MIN_BRANCH_DIAMETER_IN = 4;

export interface DuctRoomInput {
  id: string;
  name: string;
  /** Explicit airflow. When null, airflow is shared from loadBtuh. */
  cfm: number | null;
  loadBtuh: number | null;
  /** Equivalent length of this branch (straight run + fittings), ft. */
  runLengthFt: number;
}

export interface DuctInputs {
  /** Total system airflow. When null: coolingBtuh / 12000 * cfmPerTon. */
  totalCfm: number | null;
  coolingBtuh: number;
  cfmPerTon: number;
  availableStaticInWc: number;
  componentLossesInWc: number;
  /** Supply trunk equivalent length from the air handler to the last branch takeoff, ft. */
  trunkLengthFt: number;
  /** Total effective length of the return path, ft. */
  returnLengthFt: number;
  rooms: DuctRoomInput[];
}

export interface RectOption {
  heightIn: number;
  widthIn: number;
}

export interface DuctSection {
  cfm: number;
  frictionRate: number;
  exactDiameterIn: number;
  roundSizeIn: number;
  velocityFpm: number;
  rect: RectOption[];
}

export interface DuctBranch extends DuctSection {
  id: string;
  name: string;
  runLengthFt: number;
  velocityLimited: boolean;
}

export interface DuctResult {
  totalCfm: number;
  systemFrictionRate: number;
  availableFrictionInWc: number;
  supplyTrunk: DuctSection;
  returnTrunk: DuctSection;
  branches: DuctBranch[];
  warnings: string[];
}

export type DuctFieldErrors = Partial<Record<string, string>>;

export function defaultDuctInputs(coolingBtuh = 36000): DuctInputs {
  return {
    totalCfm: null,
    coolingBtuh,
    cfmPerTon: 400,
    availableStaticInWc: 0.5,
    componentLossesInWc: 0.25,
    trunkLengthFt: 60,
    returnLengthFt: 80,
    rooms: [],
  };
}

/** Round-duct diameter (in) for airflow (cfm) at a friction rate (in.wc/100 ft). ASHRAE equal-friction relation. */
export function roundDiameterIn(cfm: number, frictionRate: number): number {
  if (!(cfm > 0) || !(frictionRate > 0)) return 0;
  return Math.pow((0.109136 * Math.pow(cfm, 1.9)) / frictionRate, 1 / 5.02);
}

export function roundDuctVelocityFpm(cfm: number, diameterIn: number): number {
  if (!(diameterIn > 0)) return 0;
  const areaFt2 = (Math.PI * Math.pow(diameterIn / 12, 2)) / 4;
  return cfm / areaFt2;
}

/** Smallest round diameter (in) that keeps velocity at or under the limit. */
export function minDiameterForVelocityIn(cfm: number, limitFpm: number): number {
  if (!(cfm > 0) || !(limitFpm > 0)) return 0;
  return 12 * Math.sqrt((4 * cfm) / (limitFpm * Math.PI));
}

/** Next standard round size at or above the requested diameter (largest size if beyond the table). */
export function nextRoundSizeIn(diameterIn: number): number {
  const exact = STANDARD_ROUND_SIZES_IN.find((s) => s >= diameterIn - 1e-9);
  return exact ?? STANDARD_ROUND_SIZES_IN[STANDARD_ROUND_SIZES_IN.length - 1];
}

/** Equivalent diameter of a rectangular duct (Huebscher). */
export function equivalentDiameterIn(aIn: number, bIn: number): number {
  return (1.3 * Math.pow(aIn * bIn, 0.625)) / Math.pow(aIn + bIn, 0.25);
}

/** Rectangular sizes (whole inches, aspect ratio up to 4:1) equal in friction to the round diameter. */
export function rectangularOptions(diameterIn: number, heights: number[] = [6, 8, 10, 12]): RectOption[] {
  const out: RectOption[] = [];
  for (const h of heights) {
    let lo = 2;
    let hi = 80;
    if (equivalentDiameterIn(h, hi) < diameterIn) continue;
    for (let n = 0; n < 60; n += 1) {
      const mid = (lo + hi) / 2;
      if (equivalentDiameterIn(h, mid) < diameterIn) lo = mid;
      else hi = mid;
    }
    const width = Math.ceil(hi - 1e-9);
    const ratio = Math.max(width, h) / Math.min(width, h);
    if (width >= 4 && ratio <= 4) out.push({ heightIn: h, widthIn: width });
  }
  return out;
}

export function validateDuctInputs(i: DuctInputs): DuctFieldErrors {
  const e: DuctFieldErrors = {};
  if (i.totalCfm !== null) range(e, 'totalCfm', i.totalCfm, 100, 6000, 'System airflow');
  else range(e, 'coolingBtuh', i.coolingBtuh, 6000, 120000, 'Cooling capacity');
  range(e, 'cfmPerTon', i.cfmPerTon, 250, 550, 'Airflow per ton');
  range(e, 'availableStaticInWc', i.availableStaticInWc, 0.2, 1.2, 'Available static pressure');
  range(e, 'componentLossesInWc', i.componentLossesInWc, 0, 1, 'Component pressure losses');
  range(e, 'trunkLengthFt', i.trunkLengthFt, 5, 400, 'Supply trunk length');
  range(e, 'returnLengthFt', i.returnLengthFt, 5, 600, 'Return length');
  if (
    isNum(i.availableStaticInWc) && isNum(i.componentLossesInWc) &&
    i.componentLossesInWc >= i.availableStaticInWc
  ) {
    e.componentLossesInWc = 'Component losses must be lower than the available static pressure.';
  }
  if (!Array.isArray(i.rooms) || i.rooms.length === 0) e.rooms = 'Add at least one room.';
  else if (i.rooms.length > 40) e.rooms = 'Use 40 rooms or fewer.';
  else {
    i.rooms.forEach((r, idx) => {
      if (!r.name.trim()) e[`room_${idx}_name`] = 'Name the room.';
      if (!isNum(r.runLengthFt) || r.runLengthFt < 1 || r.runLengthFt > 300) {
        e[`room_${idx}_run`] = 'Run length must be between 1 and 300 ft.';
      }
      const hasCfm = isNum(r.cfm) && r.cfm > 0;
      const hasLoad = isNum(r.loadBtuh) && r.loadBtuh > 0;
      if (!hasCfm && !hasLoad) e[`room_${idx}_flow`] = 'Enter the room airflow (cfm) or its load (Btu/h).';
    });
  }
  return e;
}

function buildSection(cfm: number, frictionRate: number, velocityLimit: number, minDiameter: number): DuctSection & { velocityLimited: boolean } {
  const byFriction = roundDiameterIn(cfm, frictionRate);
  const byVelocity = minDiameterForVelocityIn(cfm, velocityLimit);
  const exact = Math.max(byFriction, byVelocity, minDiameter);
  const roundSize = nextRoundSizeIn(exact);
  return {
    cfm: round0(cfm),
    frictionRate: Math.round(frictionRate * 1000) / 1000,
    exactDiameterIn: Math.round(exact * 10) / 10,
    roundSizeIn: roundSize,
    velocityFpm: round0(roundDuctVelocityFpm(cfm, roundSize)),
    rect: rectangularOptions(exact),
    velocityLimited: byVelocity > byFriction + 1e-9,
  };
}

/** Throws RangeError for inputs that fail validateDuctInputs(): callers validate first. */
export function computeDuctDesign(i: DuctInputs): DuctResult {
  const errors = validateDuctInputs(i);
  if (Object.keys(errors).length > 0) throw new RangeError(`Invalid duct inputs: ${Object.keys(errors).join(', ')}`);

  const warnings: string[] = [];
  const totalCfm = i.totalCfm ?? (i.coolingBtuh / 12000) * i.cfmPerTon;
  const availableFriction = i.availableStaticInWc - i.componentLossesInWc;

  // The longest supply path plus the return path sets the system friction rate.
  const longestRun = Math.max(...i.rooms.map((r) => r.runLengthFt));
  const longestTel = i.trunkLengthFt + longestRun + i.returnLengthFt;
  const systemFriction = (availableFriction * 100) / longestTel;

  if (systemFriction < DESIGN_FRICTION_RANGE.min) {
    warnings.push(
      `Friction rate is low (${systemFriction.toFixed(3)} in.wc/100 ft). The longest path is long for this blower. Shorten it, raise the static pressure budget, or expect large ducts.`,
    );
  }
  if (systemFriction > DESIGN_FRICTION_RANGE.max) {
    warnings.push(
      `Friction rate is high (${systemFriction.toFixed(3)} in.wc/100 ft). Small ducts at this rate tend to be noisy. Check the length and component losses.`,
    );
  }

  // Room airflows: explicit cfm wins; the rest share the remainder by load.
  const explicit = i.rooms.reduce((a, r) => a + (isNum(r.cfm) && r.cfm > 0 ? r.cfm : 0), 0);
  const loadRooms = i.rooms.filter((r) => !(isNum(r.cfm) && r.cfm > 0));
  const loadTotal = loadRooms.reduce((a, r) => a + (r.loadBtuh ?? 0), 0);
  const remainder = Math.max(0, totalCfm - explicit);
  if (loadRooms.length === 0 && Math.abs(explicit - totalCfm) / totalCfm > 0.1) {
    warnings.push(
      `Room airflows add up to ${round0(explicit)} cfm, which differs from the ${round0(totalCfm)} cfm system airflow by more than 10%.`,
    );
  }
  if (loadRooms.length > 0 && remainder <= 0) {
    warnings.push('Explicit room airflows already use the whole system airflow, so rooms sized by load get nothing.');
  }

  const branches: DuctBranch[] = i.rooms.map((r) => {
    const roomCfm = isNum(r.cfm) && r.cfm > 0 ? r.cfm : loadTotal > 0 ? (remainder * (r.loadBtuh ?? 0)) / loadTotal : 0;
    const tel = i.trunkLengthFt + r.runLengthFt + i.returnLengthFt;
    const branchFriction = Math.min((availableFriction * 100) / tel, 0.3);
    const s = buildSection(roomCfm, branchFriction, VELOCITY_LIMITS_FPM.branch, MIN_BRANCH_DIAMETER_IN);
    if (roomCfm < 25) warnings.push(`${r.name || 'A room'} gets under 25 cfm. A 4 in. duct is already larger than needed.`);
    if (s.velocityFpm > VELOCITY_LIMITS_FPM.branch + 50) {
      warnings.push(`${r.name || 'A room'} branch runs at ${s.velocityFpm} fpm, above the ${VELOCITY_LIMITS_FPM.branch} fpm target. Use a larger or second duct.`);
    }
    return { ...s, id: r.id, name: r.name.trim(), runLengthFt: r.runLengthFt };
  });

  const supply = buildSection(totalCfm, systemFriction, VELOCITY_LIMITS_FPM.trunk, MIN_BRANCH_DIAMETER_IN);
  const returns = buildSection(totalCfm, systemFriction, VELOCITY_LIMITS_FPM.return, MIN_BRANCH_DIAMETER_IN);
  const { velocityLimited: _supplyLimited, ...supplyTrunk } = supply;
  const { velocityLimited: _returnLimited, ...returnTrunk } = returns;
  void _supplyLimited;
  void _returnLimited;

  if (totalCfm / 400 > 5.5) warnings.push('System airflow above 5 tons: consider a split trunk or multiple returns.');

  return {
    totalCfm: round0(totalCfm),
    systemFrictionRate: Math.round(systemFriction * 1000) / 1000,
    availableFrictionInWc: Math.round(availableFriction * 1000) / 1000,
    supplyTrunk,
    returnTrunk,
    branches,
    warnings,
  };
}

// ============================================================
// DEFENSIVE PARSING (saved jsonb arrives as `unknown`)
// ============================================================

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
function numOr(v: unknown, fallback: number): number {
  return isNum(v) ? v : fallback;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Rebuilds load inputs from saved data; anything missing or malformed falls back to the default. */
export function sanitizeLoadInputs(raw: unknown): HvacLoadInputs {
  const d = defaultLoadInputs();
  if (!isRecord(raw)) return d;
  const w = isRecord(raw.windowAreaSqft) ? raw.windowAreaSqft : {};
  return {
    outdoorSummerDb: numOr(raw.outdoorSummerDb, d.outdoorSummerDb),
    outdoorWinterDb: numOr(raw.outdoorWinterDb, d.outdoorWinterDb),
    indoorSummerDb: numOr(raw.indoorSummerDb, d.indoorSummerDb),
    indoorWinterDb: numOr(raw.indoorWinterDb, d.indoorWinterDb),
    humidity: pick(raw.humidity, ['dry', 'moderate', 'humid'] as const, d.humidity),
    elevationFt: numOr(raw.elevationFt, d.elevationFt),
    conditionedAreaSqft: numOr(raw.conditionedAreaSqft, d.conditionedAreaSqft),
    ceilingHeightFt: numOr(raw.ceilingHeightFt, d.ceilingHeightFt),
    stories: raw.stories === 2 || raw.stories === 3 ? raw.stories : 1,
    aspectRatio: numOr(raw.aspectRatio, d.aspectRatio),
    exteriorWallAreaOverrideSqft: isNum(raw.exteriorWallAreaOverrideSqft) ? raw.exteriorWallAreaOverrideSqft : null,
    wallR: numOr(raw.wallR, d.wallR),
    ceilingR: numOr(raw.ceilingR, d.ceilingR),
    floorR: numOr(raw.floorR, d.floorR),
    ceilingType: pick(raw.ceilingType, ['attic', 'cathedral', 'conditioned_above'] as const, d.ceilingType),
    floorType: pick(raw.floorType, ['slab', 'crawlspace', 'basement', 'over_garage', 'conditioned_below'] as const, d.floorType),
    slabEdgeInsulated: raw.slabEdgeInsulated === true,
    exteriorColor: pick(raw.exteriorColor, ['light', 'medium', 'dark'] as const, d.exteriorColor),
    windowAreaSqft: {
      n: numOr(w.n, d.windowAreaSqft.n),
      e: numOr(w.e, d.windowAreaSqft.e),
      s: numOr(w.s, d.windowAreaSqft.s),
      w: numOr(w.w, d.windowAreaSqft.w),
    },
    windowU: numOr(raw.windowU, d.windowU),
    windowShgc: numOr(raw.windowShgc, d.windowShgc),
    windowShading: pick(raw.windowShading, ['none', 'blinds', 'drapes', 'exterior'] as const, d.windowShading),
    doorAreaSqft: numOr(raw.doorAreaSqft, d.doorAreaSqft),
    airTightness: pick(raw.airTightness, ['tight', 'average', 'loose'] as const, d.airTightness),
    ventilationCfm: numOr(raw.ventilationCfm, d.ventilationCfm),
    ventilationRecovery: pick(raw.ventilationRecovery, ['none', 'hrv', 'erv'] as const, d.ventilationRecovery),
    occupants: numOr(raw.occupants, d.occupants),
    applianceSensibleBtuh: numOr(raw.applianceSensibleBtuh, d.applianceSensibleBtuh),
    ductLocation: pick(raw.ductLocation, ['conditioned', 'basement', 'crawlspace', 'attic', 'attic_leaky'] as const, d.ductLocation),
  };
}

export function sanitizeDuctInputs(raw: unknown, coolingBtuh: number): DuctInputs {
  const d = defaultDuctInputs(coolingBtuh);
  if (!isRecord(raw)) return d;
  const rooms: DuctRoomInput[] = Array.isArray(raw.rooms)
    ? raw.rooms.filter(isRecord).slice(0, 40).map((r, idx) => ({
        id: typeof r.id === 'string' && r.id ? r.id : `room-${idx}`,
        name: typeof r.name === 'string' ? r.name.slice(0, 60) : '',
        cfm: isNum(r.cfm) ? r.cfm : null,
        loadBtuh: isNum(r.loadBtuh) ? r.loadBtuh : null,
        runLengthFt: numOr(r.runLengthFt, 25),
      }))
    : [];
  return {
    totalCfm: isNum(raw.totalCfm) ? raw.totalCfm : null,
    coolingBtuh: numOr(raw.coolingBtuh, d.coolingBtuh),
    cfmPerTon: numOr(raw.cfmPerTon, d.cfmPerTon),
    availableStaticInWc: numOr(raw.availableStaticInWc, d.availableStaticInWc),
    componentLossesInWc: numOr(raw.componentLossesInWc, d.componentLossesInWc),
    trunkLengthFt: numOr(raw.trunkLengthFt, d.trunkLengthFt),
    returnLengthFt: numOr(raw.returnLengthFt, d.returnLengthFt),
    rooms,
  };
}
