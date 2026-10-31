import { describe, expect, it } from "vitest";
import { findDuplicateBooking } from "./bookingIdempotency.ts";

const existing = [{ id: "j1", customer_name: "Ann Lee", scheduled_datetime: "2027-03-01T15:00:00+00:00" }];

describe("findDuplicateBooking (double delivery of book_appointment)", () => {
  it("same customer + same instant in a different ISO format is a duplicate", () => {
    expect(findDuplicateBooking(existing, { customerName: " ann lee ", scheduledDatetime: "2027-03-01T15:00:00.000Z" })?.id).toBe("j1");
    expect(findDuplicateBooking(existing, { customerName: "Ann Lee", scheduledDatetime: "2027-03-01T10:00:00-05:00" })?.id).toBe("j1");
  });
  it("different time or different customer is a NEW booking (a real second job is never swallowed)", () => {
    expect(findDuplicateBooking(existing, { customerName: "Ann Lee", scheduledDatetime: "2027-03-01T16:00:00Z" })).toBeNull();
    expect(findDuplicateBooking(existing, { customerName: "Bob", scheduledDatetime: "2027-03-01T15:00:00Z" })).toBeNull();
  });
  it("unscheduled bookings dedupe only against other unscheduled ones", () => {
    const un = [{ id: "j2", customer_name: "Cy", scheduled_datetime: null }];
    expect(findDuplicateBooking(un, { customerName: "cy", scheduledDatetime: null })?.id).toBe("j2");
    expect(findDuplicateBooking(un, { customerName: "Cy", scheduledDatetime: "2027-03-01T15:00:00Z" })).toBeNull();
    expect(findDuplicateBooking(existing, { customerName: "Ann Lee", scheduledDatetime: null })).toBeNull();
  });
  it("empty list / garbage date -> null", () => {
    expect(findDuplicateBooking([], { customerName: "x", scheduledDatetime: null })).toBeNull();
    expect(findDuplicateBooking(existing, { customerName: "Ann Lee", scheduledDatetime: "not-a-date" })).toBeNull();
  });
});
