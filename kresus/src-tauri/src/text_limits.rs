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

// Match HTML maxlength, which counts UTF-16 code units.
pub(crate) fn validate_reference_length(value: Option<&str>) -> Result<(), String> {
    if value.is_some_and(|v| v.trim().encode_utf16().count() > 50) {
        return Err("La référence ne peut pas dépasser 50 caractères.".into());
    }
    Ok(())
}
