#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol};

#[contract]
pub struct CrowdfundContract;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Initialized,
    Admin,
    Goal,
    TotalRaised,
    Donation(Address),
    Donors,
}

#[contracttype]
#[derive(Clone)]
pub struct Campaign {
    pub admin: Address,
    pub goal: i128,
    pub total_raised: i128,
    pub donors: u32,
}

const DONATION_EVENT: Symbol = symbol_short!("donation");

#[contractimpl]
impl CrowdfundContract {
    pub fn initialize(env: Env, admin: Address, goal: i128) {
        if env.storage().instance().has(&DataKey::Initialized) {
            panic!("already initialized");
        }
        if goal <= 0 {
            panic!("goal must be greater than zero");
        }

        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Goal, &goal);
        env.storage().instance().set(&DataKey::TotalRaised, &0_i128);
        env.storage().instance().set(&DataKey::Donors, &0_u32);
    }

    pub fn donate(env: Env, donor: Address, amount: i128) {
        if !env.storage().instance().has(&DataKey::Initialized) {
            panic!("contract is not initialized");
        }
        if amount <= 0 {
            panic!("amount must be greater than zero");
        }

        donor.require_auth();

        let donor_key = DataKey::Donation(donor.clone());
        let donor_total = env.storage().instance().get::<_, i128>(&donor_key).unwrap_or(0_i128);
        let updated_donor_total = donor_total
            .checked_add(amount)
            .unwrap_or_else(|| panic!("donor total overflow"));

        let total = env
            .storage()
            .instance()
            .get::<_, i128>(&DataKey::TotalRaised)
            .unwrap_or(0_i128);
        let updated_total = total
            .checked_add(amount)
            .unwrap_or_else(|| panic!("campaign total overflow"));

        if donor_total == 0 {
            let donors = env
                .storage()
                .instance()
                .get::<_, u32>(&DataKey::Donors)
                .unwrap_or(0_u32);
            env.storage()
                .instance()
                .set(&DataKey::Donors, &(donors.checked_add(1).unwrap_or(u32::MAX)));
        }

        env.storage().instance().set(&donor_key, &updated_donor_total);
        env.storage().instance().set(&DataKey::TotalRaised, &updated_total);
        env.events().publish((DONATION_EVENT, donor), (amount, updated_total));
    }

    pub fn get_campaign(env: Env) -> Campaign {
        Campaign {
            admin: env.storage().instance().get(&DataKey::Admin).unwrap(),
            goal: env.storage().instance().get(&DataKey::Goal).unwrap_or(0_i128),
            total_raised: env
                .storage()
                .instance()
                .get(&DataKey::TotalRaised)
                .unwrap_or(0_i128),
            donors: env.storage().instance().get(&DataKey::Donors).unwrap_or(0_u32),
        }
    }

    pub fn get_donation(env: Env, donor: Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Donation(donor))
            .unwrap_or(0_i128)
    }

    pub fn is_goal_reached(env: Env) -> bool {
        let goal: i128 = env.storage().instance().get(&DataKey::Goal).unwrap_or(0_i128);
        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalRaised)
            .unwrap_or(0_i128);
        total >= goal
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn donation_updates_state() {
        let env = Env::default();
        let contract_id = env.register(CrowdfundContract, ());
        let client = CrowdfundContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let donor = Address::generate(&env);

        client.initialize(&admin, &1_000_000_i128);
        client.donate(&donor, &250_000_i128);

        let campaign = client.get_campaign();
        assert_eq!(campaign.total_raised, 250_000_i128);
        assert_eq!(campaign.goal, 1_000_000_i128);
        assert_eq!(campaign.donors, 1_u32);
        assert_eq!(client.get_donation(&donor), 250_000_i128);
        assert!(!client.is_goal_reached());
    }
}
