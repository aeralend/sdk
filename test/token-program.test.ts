import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Connection, Keypair, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import idl from '../idl/aera.json' with { type: 'json' };
import { AeraAdmin, AeraClient, COOK_RESERVE_CONFIG } from '../src/index.js';
import { assertU64 } from '../src/client.js';

const owner = Keypair.generate().publicKey;
const repayer = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const collateralMint = Keypair.generate().publicKey;
const obligation = Keypair.generate().publicKey;

function fixture(tokenProgram: PublicKey) {
  const connection = new Connection('http://localhost:8899', {
    fetch: async () => { throw new Error('unexpected network call in offline test'); },
  });
  connection.getLatestBlockhash = async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1 });
  const data = Buffer.alloc(82);
  data[44] = 9;
  data[45] = 1;
  connection.getAccountInfo = async () => ({ data, owner: tokenProgram, executable: false, lamports: 1 });
  const client = new AeraClient({ connection, marketId: 1 });
  client.getGlobal = async () => ({ feeDestination: repayer } as any);
  return { client, connection, data };
}

function key(ix: TransactionInstruction, name: string): PublicKey {
  const instruction = idl.instructions.find(entry => Buffer.from(entry.discriminator).equals(ix.data.subarray(0, 8)));
  assert.ok(instruction, 'instruction discriminator is in the IDL');
  const index = instruction.accounts.findIndex(entry => entry.name === name);
  assert.ok(index >= 0, `missing ${name} in IDL`);
  return ix.keys[index]!.pubkey;
}

for (const [label, tokenProgram] of [['legacy SPL', TOKEN_PROGRAM_ID], ['Token-2022', TOKEN_2022_PROGRAM_ID]] as const) {
  for (const action of ['supply', 'withdraw', 'borrow', 'repay', 'liquidate', 'liquidate transaction', 'init reserve'] as const) {
    test(`${label}: ${action} selects the liquidity program and its ATA`, async () => {
      const { client } = fixture(tokenProgram);
      let ix: TransactionInstruction;
      if (action === 'supply') ix = await client.supplyIx(owner, mint, 1n);
      else if (action === 'withdraw') ix = await client.withdrawIx(owner, mint, 1n);
      else if (action === 'borrow') ix = await client.borrowIx(owner, mint, 1n);
      else if (action === 'repay') ix = await client.repayIx(repayer, mint, 1n, owner);
      else if (action === 'liquidate') ix = await client.liquidateIx(repayer, mint, collateralMint, obligation, 1n);
      else if (action === 'liquidate transaction') {
        client.getObligation = async () => ({ address: obligation } as any);
        (client as unknown as { preludeIxs: () => Promise<TransactionInstruction[]> }).preludeIxs = async () => [];
        ix = (await client.liquidate(repayer, owner, mint, collateralMint, 1n)).instructions[0]!;
      } else ix = await new AeraAdmin(client).initReserve(owner, mint, COOK_RESERVE_CONFIG,
        { name: 'Test reserve', symbol: 'test', uri: '' });
      assert.ok(key(ix, 'liquidity_token_program').equals(tokenProgram));
      if (action !== 'init reserve') {
        const liquidation = action.startsWith('liquidate');
        const wallet = liquidation || action === 'repay' ? repayer : owner;
        assert.ok(key(ix, liquidation ? 'liquidator_repay_source' : 'user_liquidity')
          .equals(getAssociatedTokenAddressSync(mint, wallet, false, tokenProgram)));
      }
      if (['supply', 'withdraw', 'liquidate', 'liquidate transaction', 'init reserve'].includes(action)) {
        assert.ok(key(ix, 'share_token_program').equals(TOKEN_2022_PROGRAM_ID));
      }
    });
  }

  test(`${label}: batched balances query the matching liquidity ATA`, async () => {
    const { client, connection } = fixture(tokenProgram);
    const expected = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
    connection.getMultipleAccountsInfoAndContext = async keys => {
      const addresses = keys.map(key => key.toBase58());
      assert.ok(addresses.includes(expected.toBase58()));
      const data = Buffer.alloc(165); data.writeBigUInt64LE(123n, 64);
      return { context: { slot: 1 }, value: keys.map(key => key.equals(expected)
        ? { data, owner: tokenProgram, lamports: 1, executable: false } : null) };
    };
    const snapshot = await client.readAtSlot({ cookMint: mint, owner });
    assert.equal(snapshot.balances.cook, 123n);
  });
}

test('missing mint, unsupported owner, malformed mint and uninitialized mint fail closed', async () => {
  const { client, connection, data } = fixture(TOKEN_2022_PROGRAM_ID);
  connection.getAccountInfo = async () => null;
  await assert.rejects(client.supplyIx(owner, mint, 1n), /does not exist/);
  connection.getAccountInfo = async () => ({ data, owner: SystemProgram.programId, lamports: 1, executable: false });
  await assert.rejects(client.borrowIx(owner, mint, 1n), /unsupported token program/);
  connection.getAccountInfo = async () => ({ data: Buffer.alloc(4), owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false });
  await assert.rejects(client.repayIx(repayer, mint, 1n), /TokenInvalidAccountSizeError/);
  data[45] = 0;
  connection.getAccountInfo = async () => ({ data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false });
  await assert.rejects(new AeraAdmin(client).initReserve(owner, mint, COOK_RESERVE_CONFIG,
    { name: 'Test', symbol: 'test', uri: '' }), /not initialized/);
});

test('RPC failure never silently selects the legacy program', async () => {
  const { client, connection } = fixture(TOKEN_2022_PROGRAM_ID);
  connection.getAccountInfo = async () => { throw new Error('RPC unavailable'); };
  await assert.rejects(client.withdrawIx(owner, mint, 1n), /RPC unavailable/);
});

test('amounts outside u64 are refused before encoding, by every amount builder', async () => {
  const { client } = fixture(TOKEN_PROGRAM_ID);
  client.getObligation = async () => ({ address: obligation } as any);
  const builders: Array<[string, (amount: bigint) => Promise<unknown>]> = [
    ['supplyIx', (a) => client.supplyIx(owner, mint, a)],
    ['withdrawIx', (a) => client.withdrawIx(owner, mint, a)],
    ['depositCollateralIx', (a) => client.depositCollateralIx(owner, collateralMint, a)],
    ['withdrawCollateralIx', (a) => client.withdrawCollateralIx(owner, collateralMint, a)],
    ['borrowIx', (a) => client.borrowIx(owner, mint, a)],
    ['repayIx', (a) => client.repayIx(repayer, mint, a)],
    ['liquidateIx', (a) => client.liquidateIx(repayer, mint, collateralMint, obligation, a)],
  ];
  for (const [name, build] of builders) {
    // -5n used to encode as 5: BN takes the magnitude.
    await assert.rejects(build(-5n), RangeError, `${name} accepted -5n`);
    await assert.rejects(build(2n ** 64n), RangeError, `${name} accepted 2^64`);
    await build(2n ** 64n - 1n);
  }
  (client as unknown as { preludeIxs: () => Promise<TransactionInstruction[]> }).preludeIxs = async () => [];
  await assert.rejects(client.liquidate(repayer, owner, mint, collateralMint, -5n), RangeError);
});

test('the u64 bound is exact, and the encoded value is the value given', async () => {
  assert.throws(() => assertU64(-1n), RangeError);
  assert.throws(() => assertU64(2n ** 64n), RangeError);
  assert.equal(assertU64(2n ** 64n - 1n).toString(), (2n ** 64n - 1n).toString());
  const { client } = fixture(TOKEN_PROGRAM_ID);
  const ix = await client.supplyIx(owner, mint, 2n ** 64n - 1n);
  assert.equal(ix.data.readBigUInt64LE(8), 2n ** 64n - 1n);
});
