// HTML maxlength counts UTF-16 code units, including two units for many emoji.
pub(crate) const NAME_LIMIT: usize = 200;

pub(crate) fn validate_name_length(value: &str, unchanged: bool) -> Result<(), String> {
    if !unchanged && value.trim().encode_utf16().count() > NAME_LIMIT {
        return Err(format!(
            "Ce champ ne peut pas dépasser {NAME_LIMIT} caractères."
        ));
    }
    Ok(())
}
