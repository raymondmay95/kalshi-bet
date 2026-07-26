import { describe, expect, it } from "vitest";
import { parseOrderBookResponse } from "../src/kalshi/kalshi-types.js";

describe("Kalshi orderbook parsing", () => {
  it("parses orderbook_fp dollar format", () => {
    const book = parseOrderBookResponse({
      orderbook_fp: {
        yes_dollars: [["0.2400", "100"]],
        no_dollars: [["0.7600", "200"]],
      },
    });

    expect(book.yes[0]).toEqual({ price: 0.24, quantity: 100 });
    expect(book.no[0]).toEqual({ price: 0.76, quantity: 200 });
  });

  it("parses legacy cent-based orderbook format", () => {
    const book = parseOrderBookResponse({
      orderbook: {
        yes: [[55, 10]],
        no: [[45, 20]],
      },
    });

    expect(book.yes[0]).toEqual({ price: 0.55, quantity: 10 });
    expect(book.no[0]).toEqual({ price: 0.45, quantity: 20 });
  });
});
