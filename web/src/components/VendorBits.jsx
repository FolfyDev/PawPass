import { Pill } from './Bits.jsx';

export const AREA_LABEL = { DEALERS_DEN: "Dealers' den", ARTIST_ALLEY: 'Artist alley' };

export const VendorStatus = ({ status }) => ({
  SUBMITTED: <Pill tone="wait">Under review</Pill>,
  WAITLISTED: <Pill tone="wait">Waitlisted</Pill>,
  ACCEPTED: <Pill tone="wait">Accepted · fee due</Pill>,
  CONFIRMED: <Pill tone="go">Confirmed</Pill>,
  DECLINED: <Pill tone="stop">Not this time</Pill>,
  WITHDRAWN: <Pill>Withdrawn</Pill>,
  CANCELLED: <Pill tone="stop">Cancelled</Pill>,
}[status] || null);
