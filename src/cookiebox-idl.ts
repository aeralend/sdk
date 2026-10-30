/** Cookiebox limit-order IDL, cookiechain/cookie-mcp d2327c2, MIT. See THIRD_PARTY_NOTICES.md. */
export const COOKIEBOX_IDL = {
  address: "L1M1tkE57jpgimzjs5S8HVsmwk4uwrWoDFuUvXpVniH",
  metadata: {
    name: "limit_order",
    version: "0.1.0",
    spec: "0.1.0",
    description:
      "Non-custodial limit orders on Cookie Chain, filled by flash-fill sandwich",
  },
  instructions: [
    {
      name: "cancel_order",
      discriminator: [95, 129, 237, 240, 8, 49, 223, 132],
      accounts: [
        {
          name: "order",
          writable: true,
          pda: {
            seeds: [
              {
                kind: "const",
                value: [111, 114, 100, 101, 114],
              },
              {
                kind: "account",
                path: "order.base",
                account: "Order",
              },
            ],
          },
        },
        {
          name: "maker",
          writable: true,
          signer: true,
          relations: ["order"],
        },
        {
          name: "reserve",
          writable: true,
          pda: {
            seeds: [
              {
                kind: "const",
                value: [114, 101, 115, 101, 114, 118, 101],
              },
              {
                kind: "account",
                path: "order",
              },
            ],
          },
          relations: ["order"],
        },
        {
          name: "maker_input_account",
          docs: [
            "Checked against the account pinned at placement, not merely against the mint — a",
            "cancel cannot be redirected any more than a fill can. Either a token account for",
            "`input_mint`, or the maker's wallet for a native-refund order (see `initialize_order`).",
          ],
          writable: true,
        },
        {
          name: "input_mint",
          relations: ["order"],
        },
        {
          name: "token_program",
        },
      ],
      args: [],
    },
    {
      name: "initialize_order",
      discriminator: [133, 110, 74, 175, 112, 159, 245, 159],
      accounts: [
        {
          name: "base",
          docs: [
            "A throwaway keypair supplied by the client. It seeds the order PDA, so a maker can",
            "have unlimited concurrent orders with no nonce counter to race on.",
          ],
          signer: true,
        },
        {
          name: "maker",
          writable: true,
          signer: true,
        },
        {
          name: "order",
          writable: true,
          pda: {
            seeds: [
              {
                kind: "const",
                value: [111, 114, 100, 101, 114],
              },
              {
                kind: "account",
                path: "base",
              },
            ],
          },
        },
        {
          name: "reserve",
          docs: ["The escrow vault, owned by the order PDA."],
          writable: true,
          pda: {
            seeds: [
              {
                kind: "const",
                value: [114, 101, 115, 101, 114, 118, 101],
              },
              {
                kind: "account",
                path: "order",
              },
            ],
          },
        },
        {
          name: "maker_input_account",
          docs: [
            "The account the escrow is funded FROM. It is also pinned as the refund destination —",
            "unless `refund_native` is set (native input only), in which case the maker's wallet is",
            "pinned instead and a cancel/expiry closes the reserve straight into it as lamports. A",
            "maker who paid COOK then gets COOK back, with no wCOOK left to unwrap by hand.",
          ],
          writable: true,
        },
        {
          name: "maker_output_account",
          docs: [
            "Pinned onto the order — every fill pays here and nowhere else. Either a token account",
            "for `output_mint` (its owner is *not* constrained to the maker: a maker may want the",
            "output delivered to another account they control), or — only when `output_mint` is the",
            "native mint — the maker's own wallet, in which case a fill pays lamports, not wCOOK.",
            "Validated in `assert_output_destination`.",
          ],
        },
        {
          name: "input_mint",
        },
        {
          name: "output_mint",
        },
        {
          name: "input_mint_token_program",
        },
        {
          name: "output_mint_token_program",
        },
        {
          name: "system_program",
          address: "11111111111111111111111111111111",
        },
        {
          name: "curve_pool",
          docs: [
            "CURVE BUY only: the MomoSwap pool whose curve this order buys on. Validated in",
            "`assert_curve_destination` and pinned onto the order. `None` for every other kind.",
            "Kept LAST so the account indices of everything above are unchanged: a client built",
            "against the previous IDL that omits it still places non-curve orders (Anchor reads a",
            "missing trailing optional account as `None`).",
          ],
          optional: true,
        },
      ],
      args: [
        {
          name: "making_amount",
          type: "u64",
        },
        {
          name: "taking_amount",
          type: "u64",
        },
        {
          name: "expired_at",
          type: {
            option: "i64",
          },
        },
        {
          name: "kind",
          type: "u8",
        },
        {
          name: "refund_native",
          type: "bool",
        },
        {
          name: "trigger_taking_amount",
          type: "u64",
        },
      ],
    },
  ],
  accounts: [
    {
      name: "Fee",
      discriminator: [24, 55, 150, 250, 168, 27, 101, 178],
    },
    {
      name: "Order",
      discriminator: [134, 173, 223, 185, 77, 86, 28, 51],
    },
  ],
  types: [
    {
      name: "Fee",
      docs: [
        'Global fee configuration — a singleton at `["fee"]` that is *also* the token authority',
        "over every `program_fee_account`.",
        "",
        "The fee deliberately does not live on the `Order`: keeping it here means it is",
        "retunable by the admin with no program upgrade and no account migration.",
      ],
      type: {
        kind: "struct",
        fields: [
          {
            name: "maker_fee",
            docs: [
              "Deducted from what the maker receives on a fill (Jupiter's platform fee): the maker is",
              "paid `required_out - maker_fee`, the vault gets the difference. This is the fee that is",
              "real revenue whoever fills — a taker fee paid by our own keeper is pocket to pocket.",
            ],
            type: "u64",
          },
          {
            name: "maker_stable_fee",
            type: "u64",
          },
          {
            name: "taker_fee",
            docs: ["Charged to the taker on top of the maker's limit price."],
            type: "u64",
          },
          {
            name: "taker_stable_fee",
            type: "u64",
          },
        ],
      },
    },
    {
      name: "Order",
      docs: [
        "A resting limit order. Field names match Jupiter Limit Order v2 so its published IDL",
        "stays a usable reference.",
        "",
        '"Making" is the maker\'s side: the input token it escrows. "Taking" is what the maker',
        "requires back. A fill is `pre_flash_fill_order` (release input to the taker) followed,",
        "in the same transaction, by `flash_fill_order` (pull the required output back out of",
        "the taker).",
      ],
      type: {
        kind: "struct",
        fields: [
          {
            name: "maker",
            type: "pubkey",
          },
          {
            name: "input_mint",
            type: "pubkey",
          },
          {
            name: "output_mint",
            type: "pubkey",
          },
          {
            name: "waiting",
            docs: [
              "A fill is mid-flight: input has been released but not yet settled. The reentrancy",
              "guard — two releases against one settlement would double-spend the reserve.",
            ],
            type: "bool",
          },
          {
            name: "ori_making_amount",
            type: "u64",
          },
          {
            name: "ori_taking_amount",
            type: "u64",
          },
          {
            name: "making_amount",
            docs: ["Input still escrowed in the reserve."],
            type: "u64",
          },
          {
            name: "taking_amount",
            docs: ["Output still required for the remaining `making_amount`."],
            type: "u64",
          },
          {
            name: "maker_input_account",
            docs: ["PINNED at placement — a cancel refunds only here."],
            type: "pubkey",
          },
          {
            name: "maker_output_account",
            docs: ["PINNED at placement — a fill pays only here."],
            type: "pubkey",
          },
          {
            name: "reserve",
            type: "pubkey",
          },
          {
            name: "borrow_making_amount",
            docs: [
              "Set by `pre_flash_fill_order`, consumed by `flash_fill_order`.",
            ],
            type: "u64",
          },
          {
            name: "expired_at",
            docs: ["`None` = good-til-cancelled."],
            type: {
              option: "i64",
            },
          },
          {
            name: "base",
            docs: [
              "The PDA seed. A throwaway keypair the client generates and signs with, rather than a",
              "nonce counter — no read-then-write race when two placements are in flight.",
            ],
            type: "pubkey",
          },
          {
            name: "referral",
            type: {
              option: "pubkey",
            },
          },
          {
            name: "kind",
            docs: [
              "`ORDER_KIND_LIMIT` or `ORDER_KIND_STOP`. A stop is a below-market trigger: the program",
              "still guarantees the maker at least `taking_amount` (the FLOOR), but only `STOP_KEEPER`",
              "may fill it, and that keeper waits for the market to fall to `trigger_taking_amount`.",
            ],
            type: "u8",
          },
          {
            name: "created_at",
            docs: [
              "Unix time the order was placed, for ordering in clients. Informational only.",
            ],
            type: "i64",
          },
          {
            name: "trigger_taking_amount",
            docs: [
              "STOP only: the output (for `ori_making_amount`) at which the stop ARMS — stop-market",
              "semantics. Once the market pays this or less, the keeper sells at whatever the market",
              "gives, down to the floor `taking_amount`. Placed as `>= ori_taking_amount`. Informational",
              "to the program (only the keeper reads it); the floor is what the program enforces.",
              "0 for a plain limit order.",
            ],
            type: "u64",
          },
          {
            name: "curve_pool",
            docs: [
              "CURVE BUY only: the MomoSwap pool pinned at placement. It binds `maker_output_account` to",
              '`["user", pool, maker]` and it is what a fill re-derives the position from, so a taker',
              "cannot point the settlement at a position on some other pool. `default()` otherwise.",
            ],
            type: "pubkey",
          },
          {
            name: "curve_shares_before",
            docs: [
              "CURVE BUY only: `UserPosition.shares` as it stood when `pre_flash_fill_order_curve`",
              "released the input. The settlement compares against this, because the program cannot move",
              "shares itself — they are non-transferable and live inside the launchpad's account.",
            ],
            type: "u64",
          },
        ],
      },
    },
  ],
};
