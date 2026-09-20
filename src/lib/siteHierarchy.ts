// Types, labels and small pure helpers for the Multi-Location Commercial
// Hierarchy feature (customer -> site -> building -> floor -> room ->
// asset). Mirrors the pattern used by src/lib/contracts.ts — no data
// fetching here, that lives in the page itself. The nested shape below
// matches exactly what the `get_customer_site_hierarchy` Postgres
// function returns, so the page can drop the RPC result straight into
// state with no reshaping.

export type SiteType =
  | 'office'
  | 'retail'
  | 'medical'
  | 'industrial'
  | 'residential_complex'
  | 'hospitality'
  | 'education'
  | 'other';

export type RoomType =
  | 'mechanical'
  | 'office'
  | 'storage'
  | 'common_area'
  | 'restroom'
  | 'kitchen'
  | 'server_room'
  | 'rooftop'
  | 'other';

export const SITE_TYPE_LABELS: Record<SiteType, string> = {
  office: 'Office',
  retail: 'Retail',
  medical: 'Medical',
  industrial: 'Industrial',
  residential_complex: 'Residential complex',
  hospitality: 'Hospitality',
  education: 'Education',
  other: 'Other',
};

export const SITE_TYPE_OPTIONS: SiteType[] = [
  'office',
  'retail',
  'medical',
  'industrial',
  'residential_complex',
  'hospitality',
  'education',
  'other',
];

export const ROOM_TYPE_LABELS: Record<RoomType, string> = {
  mechanical: 'Mechanical room',
  office: 'Office',
  storage: 'Storage',
  common_area: 'Common area',
  restroom: 'Restroom',
  kitchen: 'Kitchen',
  server_room: 'Server room',
  rooftop: 'Rooftop',
  other: 'Other',
};

export const ROOM_TYPE_OPTIONS: RoomType[] = [
  'mechanical',
  'office',
  'storage',
  'common_area',
  'restroom',
  'kitchen',
  'server_room',
  'rooftop',
  'other',
];

// ---- Shape returned by the get_customer_site_hierarchy() RPC ----

export interface HierarchyRoom {
  id: string;
  name: string;
  room_type: RoomType;
  notes: string | null;
  asset_count: number;
}

export interface HierarchyFloor {
  id: string;
  name: string;
  floor_number: number | null;
  notes: string | null;
  rooms: HierarchyRoom[];
}

export interface HierarchyBuilding {
  id: string;
  name: string;
  building_code: string | null;
  notes: string | null;
  floors: HierarchyFloor[];
}

export interface HierarchySite {
  id: string;
  name: string;
  site_type: SiteType;
  address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  is_primary: boolean;
  site_contact_name: string | null;
  site_contact_phone: string | null;
  access_notes: string | null;
  notes: string | null;
  buildings: HierarchyBuilding[];
}

// A single flattened row per room, used to populate the "assign this
// asset to a room" <select> without the picker needing to know about
// the nested tree shape.
export interface RoomPickerOption {
  roomId: string;
  label: string; // "Downtown Plaza > Building A > 3rd Floor > Mechanical Room"
}

export function flattenRoomsForPicker(sites: HierarchySite[]): RoomPickerOption[] {
  const options: RoomPickerOption[] = [];
  for (const site of sites) {
    for (const building of site.buildings) {
      for (const floor of building.floors) {
        for (const room of floor.rooms) {
          options.push({
            roomId: room.id,
            label: `${site.name} > ${building.name} > ${floor.name} > ${room.name}`,
          });
        }
      }
    }
  }
  return options;
}

// City/state/postal formatted as one line under the street address —
// skips any part that's not on file instead of rendering "null".
export function formatSiteLocationLine(site: Pick<HierarchySite, 'city' | 'state' | 'postal_code'>): string | null {
  const parts = [site.city, site.state, site.postal_code].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// Total room count across the whole tree — used for the "N rooms across
// M sites" summary line at the top of the page.
export function totalRoomCount(sites: HierarchySite[]): number {
  return sites.reduce(
    (siteSum, site) =>
      siteSum +
      site.buildings.reduce(
        (buildingSum, building) => buildingSum + building.floors.reduce((floorSum, floor) => floorSum + floor.rooms.length, 0),
        0
      ),
    0
  );
}

// Total assets pinned to a room anywhere in the tree.
export function totalAssignedAssetCount(sites: HierarchySite[]): number {
  return sites.reduce(
    (siteSum, site) =>
      siteSum +
      site.buildings.reduce(
        (buildingSum, building) =>
          buildingSum +
          building.floors.reduce(
            (floorSum, floor) => floorSum + floor.rooms.reduce((roomSum, room) => roomSum + room.asset_count, 0),
            0
          ),
        0
      ),
    0
  );
}
