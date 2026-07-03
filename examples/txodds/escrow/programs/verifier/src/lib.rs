//! Verifier - per-order, **paid** arbitration over the escrow (settlement spine).
//!
//! The sibling `arbiter` program removes the buyer's take-delivery-and-refund power, but it has two
//! structural gaps this program closes:
//!
//! 1. **One global arbiter.** Its `Config` PDA is a singleton (`seeds = [b"config"]`) on a shared
//!    devnet deployment - whoever initialized it first is the arbiter for *every* order, forever.
//!    Anyone else's "arbiter" silently can't arbitrate. Here the verifier is named **per order** at
//!    `open`, so any agent can sell verification and buyers choose whom to trust, order by order.
//! 2. **Arbitration is unpaid.** A neutral third party that works for free is not an economy. Here
//!    the payer escrows a **verifier fee** alongside the deposit, and the verifier is paid its fee on
//!    **either** verdict - release or refund - so it earns from diligence, not from favouring a side.
//!
//! It also adds a liveness backstop the arbiter lacks: if the verifier itself goes dark, the payer
//! can `reclaim` after a grace period and the verifier **forfeits** its fee. Settlement holds up
//! under seller no-show *and* verifier no-show.
//!
//! The flow (same vault-as-buyer pattern as the arbiter, against the **deployed** escrow):
//!
//!   - `open`           - the payer funds a vault PDA with deposit + escrow rent + verifier fee, and
//!                        CPIs `escrow.initialize` signing *as the vault* (the vault is the escrow's
//!                        buyer). An `Order` PDA records payer / seller / verifier / fee / deadlines.
//!                        The payer now has no unilateral power over the funds.
//!   - `verify_release` - the named verifier attests the delivery passed its checks -> the seller is
//!                        paid, the verifier collects its fee, leftover rent returns to the payer.
//!   - `verify_refund`  - after the escrow deadline, the named verifier attests failure (slop or
//!                        no-show) -> the payer is refunded, the verifier still collects its fee.
//!   - `reclaim`        - at/after `reclaim_after` (deadline + grace), the payer sweeps everything
//!                        back, fee included - the non-live verifier earns nothing.
//!
//! Security posture (same checklist as the escrow): `init` (never `init_if_needed`); PDA seeds carry
//! the order `reference`; `has_one` binds verifier/seller/payer to the order; checked math on every
//! lamport move; `close = payer` returns the order rent.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use escrow::cpi::accounts::{Initialize as EscrowInit, Refund as EscrowRefund, Release as EscrowRelease};
use escrow::cpi::{initialize as escrow_initialize, refund as escrow_refund, release as escrow_release};
use escrow::program::Escrow as EscrowProgram;
use escrow::Escrow as EscrowState;

declare_id!("2ce3cMxqi423wQjC5NXNMBExa1PpybtCnLUs8uFtUvqn");

/// Move lamports out of the system-owned vault PDA, signing with its seeds.
fn vault_pay<'info>(
    system_program: &Program<'info, System>,
    vault: &UncheckedAccount<'info>,
    to: &AccountInfo<'info>,
    reference: &Pubkey,
    bump: u8,
    lamports: u64,
) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[b"vault", reference.as_ref(), &[bump]];
    let signer: &[&[&[u8]]] = &[seeds];
    transfer(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            Transfer { from: vault.to_account_info(), to: to.clone() },
            signer,
        ),
        lamports,
    )
}

#[program]
pub mod verifier {
    use super::*;

    /// Open a verified order: fund the vault (deposit + escrow rent + verifier fee), record the
    /// per-order verifier, and deposit into the escrow with the vault as the escrow's `buyer`.
    /// `deadline` is the escrow's refund deadline (unix ts); `grace_secs` extends it to
    /// `reclaim_after`, after which the payer may force a reclaim if the verifier never ruled.
    pub fn open(
        ctx: Context<Open>,
        amount: u64,
        fee: u64,
        reference: Pubkey,
        deadline: i64,
        grace_secs: i64,
    ) -> Result<()> {
        require!(amount > 0, VerifierError::ZeroAmount);
        require!(grace_secs >= 0, VerifierError::NegativeGrace);
        require_keys_neq!(ctx.accounts.verifier.key(), ctx.accounts.seller.key(), VerifierError::VerifierIsParty);
        require_keys_neq!(ctx.accounts.verifier.key(), ctx.accounts.payer.key(), VerifierError::VerifierIsParty);

        // 1) Fund the vault: deposit + rent for the escrow account it will create + the verifier fee.
        let rent = Rent::get()?.minimum_balance(8 + EscrowState::INIT_SPACE);
        let fund = amount
            .checked_add(rent)
            .and_then(|v| v.checked_add(fee))
            .ok_or(VerifierError::Overflow)?;
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            fund,
        )?;

        // 2) CPI escrow.initialize, signing AS the vault (so the vault is the escrow's buyer).
        let bump = ctx.bumps.vault;
        let seeds: &[&[u8]] = &[b"vault", reference.as_ref(), &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        escrow_initialize(
            CpiContext::new_with_signer(
                ctx.accounts.escrow_program.to_account_info(),
                EscrowInit {
                    buyer: ctx.accounts.vault.to_account_info(),
                    seller: ctx.accounts.seller.to_account_info(),
                    escrow: ctx.accounts.escrow.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                signer,
            ),
            amount,
            reference,
            deadline,
        )?;

        // 3) Record the order: who pays, who delivers, who rules, and for how much.
        let order = &mut ctx.accounts.order;
        order.payer = ctx.accounts.payer.key();
        order.seller = ctx.accounts.seller.key();
        order.verifier = ctx.accounts.verifier.key();
        order.fee = fee;
        order.deadline = deadline;
        order.reclaim_after = deadline.checked_add(grace_secs).ok_or(VerifierError::Overflow)?;
        order.bump = ctx.bumps.order;
        order.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// The named verifier attests the delivery passed its acceptance checks -> the escrow pays the
    /// seller, the verifier collects its fee, and any remainder (escrow rent) returns to the payer.
    pub fn verify_release(ctx: Context<VerifyRelease>, reference: Pubkey) -> Result<()> {
        let bump = ctx.accounts.order.vault_bump;
        let seeds: &[&[u8]] = &[b"vault", reference.as_ref(), &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        escrow_release(CpiContext::new_with_signer(
            ctx.accounts.escrow_program.to_account_info(),
            EscrowRelease {
                buyer: ctx.accounts.vault.to_account_info(), // the vault signs as the escrow's buyer
                seller: ctx.accounts.seller.to_account_info(),
                escrow: ctx.accounts.escrow.to_account_info(),
            },
            signer,
        ))?;
        settle_vault(&ctx.accounts.system_program, &ctx.accounts.vault, &ctx.accounts.verifier.to_account_info(), &ctx.accounts.payer.to_account_info(), &reference, bump, ctx.accounts.order.fee)
    }

    /// After the escrow deadline, the named verifier attests failure (rejected or undelivered) ->
    /// the payer is refunded; the verifier is still paid its fee (neutral either way).
    pub fn verify_refund(ctx: Context<VerifyRefund>, reference: Pubkey) -> Result<()> {
        let bump = ctx.accounts.order.vault_bump;
        let seeds: &[&[u8]] = &[b"vault", reference.as_ref(), &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        // escrow.refund enforces its own deadline; funds (deposit + rent) sweep back to the vault.
        escrow_refund(CpiContext::new_with_signer(
            ctx.accounts.escrow_program.to_account_info(),
            EscrowRefund {
                buyer: ctx.accounts.vault.to_account_info(),
                escrow: ctx.accounts.escrow.to_account_info(),
            },
            signer,
        ))?;
        settle_vault(&ctx.accounts.system_program, &ctx.accounts.vault, &ctx.accounts.verifier.to_account_info(), &ctx.accounts.payer.to_account_info(), &reference, bump, ctx.accounts.order.fee)
    }

    /// Liveness backstop: if the verifier never rules, the payer may sweep everything back - deposit,
    /// rent, **and** the fee (the verifier forfeits it) - at/after `reclaim_after`.
    pub fn reclaim(ctx: Context<Reclaim>, reference: Pubkey) -> Result<()> {
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.order.reclaim_after,
            VerifierError::BeforeReclaim
        );
        let bump = ctx.accounts.order.vault_bump;
        let seeds: &[&[u8]] = &[b"vault", reference.as_ref(), &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        escrow_refund(CpiContext::new_with_signer(
            ctx.accounts.escrow_program.to_account_info(),
            EscrowRefund {
                buyer: ctx.accounts.vault.to_account_info(),
                escrow: ctx.accounts.escrow.to_account_info(),
            },
            signer,
        ))?;
        // Everything in the vault - deposit, swept rent, forfeited fee - back to the payer.
        let all = ctx.accounts.vault.lamports();
        vault_pay(&ctx.accounts.system_program, &ctx.accounts.vault, &ctx.accounts.payer.to_account_info(), &reference, bump, all)
    }
}

/// After the escrow verdict lands in the vault: pay the verifier its fee, sweep the rest to the payer.
fn settle_vault<'info>(
    system_program: &Program<'info, System>,
    vault: &UncheckedAccount<'info>,
    verifier: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    reference: &Pubkey,
    bump: u8,
    fee: u64,
) -> Result<()> {
    let balance = vault.lamports();
    let fee_paid = fee.min(balance); // fee is escrowed at open, so this only caps pathological states
    vault_pay(system_program, vault, verifier, reference, bump, fee_paid)?;
    let rest = vault.lamports();
    vault_pay(system_program, vault, payer, reference, bump, rest)
}

#[account]
#[derive(InitSpace)]
pub struct Order {
    pub payer: Pubkey,
    pub seller: Pubkey,
    pub verifier: Pubkey,
    pub fee: u64,
    pub deadline: i64,      // escrow refund deadline (unix ts)
    pub reclaim_after: i64, // payer may force-reclaim at/after this (deadline + grace)
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(Accounts)]
#[instruction(amount: u64, fee: u64, reference: Pubkey)]
pub struct Open<'info> {
    #[account(mut)]
    pub payer: Signer<'info>, // the agent/human funding the order

    /// CHECK: payout destination on release, bound into the escrow at init
    pub seller: UncheckedAccount<'info>,

    /// CHECK: the per-order neutral verifier - the only key that can rule on this order
    pub verifier: UncheckedAccount<'info>,

    /// CHECK: system-owned vault PDA that acts as the escrow's "buyer". Never given data.
    #[account(mut, seeds = [b"vault", reference.as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Order::INIT_SPACE,
        seeds = [b"order", reference.as_ref()],
        bump
    )]
    pub order: Account<'info, Order>,

    /// CHECK: created by the escrow program via CPI; address validated against the escrow id
    #[account(
        mut,
        seeds = [b"escrow", vault.key().as_ref(), reference.as_ref()],
        bump,
        seeds::program = escrow_program.key()
    )]
    pub escrow: UncheckedAccount<'info>,

    pub escrow_program: Program<'info, EscrowProgram>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(reference: Pubkey)]
pub struct VerifyRelease<'info> {
    #[account(mut)]
    pub verifier: Signer<'info>, // must be the order's verifier (has_one below)

    #[account(
        mut,
        close = payer,
        has_one = verifier @ VerifierError::NotVerifier,
        has_one = seller @ VerifierError::WrongSeller,
        has_one = payer @ VerifierError::WrongPayer,
        seeds = [b"order", reference.as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, Order>,

    /// CHECK: the vault PDA = the escrow's buyer; the program signs for it via seeds
    #[account(mut, seeds = [b"vault", reference.as_ref()], bump = order.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: paid by the escrow on release; bound to the order via has_one
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,

    /// CHECK: receives leftover rent + the closed order account; bound via has_one
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,

    /// CHECK: validated + closed by the escrow program
    #[account(
        mut,
        seeds = [b"escrow", vault.key().as_ref(), reference.as_ref()],
        bump,
        seeds::program = escrow_program.key()
    )]
    pub escrow: UncheckedAccount<'info>,

    pub escrow_program: Program<'info, EscrowProgram>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(reference: Pubkey)]
pub struct VerifyRefund<'info> {
    #[account(mut)]
    pub verifier: Signer<'info>,

    #[account(
        mut,
        close = payer,
        has_one = verifier @ VerifierError::NotVerifier,
        has_one = payer @ VerifierError::WrongPayer,
        seeds = [b"order", reference.as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, Order>,

    /// CHECK: the vault PDA = the escrow's buyer; the program signs for it via seeds
    #[account(mut, seeds = [b"vault", reference.as_ref()], bump = order.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: refunded payer; bound to the order via has_one
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,

    /// CHECK: validated + closed by the escrow program
    #[account(
        mut,
        seeds = [b"escrow", vault.key().as_ref(), reference.as_ref()],
        bump,
        seeds::program = escrow_program.key()
    )]
    pub escrow: UncheckedAccount<'info>,

    pub escrow_program: Program<'info, EscrowProgram>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(reference: Pubkey)]
pub struct Reclaim<'info> {
    #[account(mut)]
    pub payer: Signer<'info>, // only the order's payer (has_one below)

    #[account(
        mut,
        close = payer,
        has_one = payer @ VerifierError::WrongPayer,
        seeds = [b"order", reference.as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, Order>,

    /// CHECK: the vault PDA = the escrow's buyer; the program signs for it via seeds
    #[account(mut, seeds = [b"vault", reference.as_ref()], bump = order.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: validated + closed by the escrow program
    #[account(
        mut,
        seeds = [b"escrow", vault.key().as_ref(), reference.as_ref()],
        bump,
        seeds::program = escrow_program.key()
    )]
    pub escrow: UncheckedAccount<'info>,

    pub escrow_program: Program<'info, EscrowProgram>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum VerifierError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Grace must not be negative")]
    NegativeGrace,
    #[msg("The verifier must be a third party - not the payer or the seller")]
    VerifierIsParty,
    #[msg("Caller is not this order's verifier")]
    NotVerifier,
    #[msg("Seller does not match the order")]
    WrongSeller,
    #[msg("Payer does not match the order")]
    WrongPayer,
    #[msg("Reclaim is only allowed at or after reclaim_after")]
    BeforeReclaim,
    #[msg("Arithmetic overflow")]
    Overflow,
}
